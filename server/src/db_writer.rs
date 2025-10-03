//! Single-threaded database writer actor for atomic-server
//!
//! This actor ensures all database write operations are performed sequentially
//! by a single thread, eliminating lock contention while allowing unlimited
//! concurrent reads through the r2d2 connection pool.

use actix::{prelude::*, Actor, Context, Handler, Addr};
use atomic_lib::{
    commit::{Commit, CommitOpts, CommitResponse},
    errors::AtomicResult,
    Resource, Storelike,
};
use tokio::sync::oneshot;
use crate::{actor_messages::CommitMessage, commit_monitor::CommitMonitor};

/// Message to add a resource to the database
#[derive(Message)]
#[rtype(result = "()")]
pub struct AddResourceMessage {
    pub resource: Resource,
    pub check_required_props: bool,
    pub update_index: bool,
    pub overwrite_existing: bool,
    pub respond_to: oneshot::Sender<AtomicResult<()>>,
}

/// Message to remove a resource from the database
#[derive(Message)]
#[rtype(result = "()")]
pub struct RemoveResourceMessage {
    pub subject: String,
    pub respond_to: oneshot::Sender<AtomicResult<()>>,
}

/// Message to apply a commit to the database
#[derive(Message)]
#[rtype(result = "()")]
pub struct ApplyCommitMessage {
    pub commit: Commit,
    pub opts: CommitOpts,
    pub respond_to: oneshot::Sender<AtomicResult<CommitResponse>>,
}

/// Message to update a resource in the database
#[derive(Message)]
#[rtype(result = "()")]
pub struct UpdateResourceMessage {
    pub resource: Resource,
    pub respond_to: oneshot::Sender<AtomicResult<()>>,
}

/// Single-threaded database writer actor
/// 
/// This actor processes all write operations sequentially, ensuring no lock
/// contention while maintaining ACID properties. All reads continue to use
/// the r2d2 pool for maximum concurrency.
pub struct DbWriter {
    /// Reference to the database for write operations
    db: atomic_lib::Db,
    /// Reference to the commit monitor for notifications
    commit_monitor: Addr<CommitMonitor>,
}

impl DbWriter {
    /// Create a new DbWriter actor
    pub fn new(db: atomic_lib::Db, commit_monitor: Addr<CommitMonitor>) -> Self {
        Self { db, commit_monitor }
    }
}

impl Actor for DbWriter {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Self::Context) {
        tracing::info!("DbWriter actor started - single write thread active");
    }

    fn stopped(&mut self, _ctx: &mut Self::Context) {
        tracing::info!("DbWriter actor stopped");
    }
}

impl Handler<AddResourceMessage> for DbWriter {
    type Result = ();

    #[tracing::instrument(
        name = "db_writer_add_resource",
        skip_all,
        fields(subject = %msg.resource.get_subject())
    )]
    fn handle(&mut self, msg: AddResourceMessage, _ctx: &mut Self::Context) {
        let result = self.db.add_resource_opts(
            &msg.resource,
            msg.check_required_props,
            msg.update_index,
            msg.overwrite_existing,
        );

        if let Err(_) = msg.respond_to.send(result) {
            tracing::warn!("Failed to send AddResource response - receiver dropped");
        }
    }
}

impl Handler<RemoveResourceMessage> for DbWriter {
    type Result = ();

    #[tracing::instrument(
        name = "db_writer_remove_resource", 
        skip_all,
        fields(subject = %msg.subject)
    )]
    fn handle(&mut self, msg: RemoveResourceMessage, _ctx: &mut Self::Context) {
        let result = self.db.remove_resource(&msg.subject);

        if let Err(_) = msg.respond_to.send(result) {
            tracing::warn!("Failed to send RemoveResource response - receiver dropped");
        }
    }
}

impl Handler<ApplyCommitMessage> for DbWriter {
    type Result = ();

    #[tracing::instrument(
        name = "db_writer_apply_commit",
        skip_all,
        fields(subject = %msg.commit.subject)
    )]
    fn handle(&mut self, msg: ApplyCommitMessage, _ctx: &mut Self::Context) {
        let result = self.db.apply_commit(msg.commit, &msg.opts);

        // Send result back to caller
        match &result {
            Ok(commit_response) => {
                // Send commit notification to commit monitor for WebSocket notifications and search indexing
                let commit_message = CommitMessage {
                    commit_response: commit_response.clone(),
                };
                self.commit_monitor.do_send(commit_message);
                
                if let Err(_) = msg.respond_to.send(result) {
                    tracing::warn!("Failed to send ApplyCommit response - receiver dropped");
                }
            }
            Err(_) => {
                if let Err(_) = msg.respond_to.send(result) {
                    tracing::warn!("Failed to send ApplyCommit response - receiver dropped");
                }
            }
        }
    }
}

impl Handler<UpdateResourceMessage> for DbWriter {
    type Result = ();

    #[tracing::instrument(
        name = "db_writer_update_resource",
        skip_all, 
        fields(subject = %msg.resource.get_subject())
    )]
    fn handle(&mut self, msg: UpdateResourceMessage, _ctx: &mut Self::Context) {
        // Update is equivalent to add with overwrite=true
        let result = self.db.add_resource_opts(
            &msg.resource,
            true,   // check_required_props
            true,   // update_index
            true,   // overwrite_existing
        );

        if let Err(_) = msg.respond_to.send(result) {
            tracing::warn!("Failed to send UpdateResource response - receiver dropped");
        }
    }
}

/// Helper function to create and start a DbWriter actor
pub fn create_db_writer(db: atomic_lib::Db, commit_monitor: Addr<CommitMonitor>) -> Addr<DbWriter> {
    tracing::info!("Creating DbWriter actor for single-threaded writes");
    DbWriter::create(move |_ctx| DbWriter::new(db, commit_monitor))
}