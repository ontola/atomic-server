use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    time::Instant,
};
thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static STATS: RefCell<BTreeMap<&'static str,(u64,u64)>> = const { RefCell::new(BTreeMap::new()) };
}
pub struct Span(&'static str, Option<Instant>);
pub fn span(name: &'static str) -> Span {
    Span(name, ACTIVE.with(|a| a.get()).then(Instant::now))
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(start) = self.1 {
            STATS.with(|s| {
                let mut stats = s.borrow_mut();
                let row = stats.entry(self.0).or_default();
                row.0 += 1;
                row.1 += start.elapsed().as_nanos() as u64;
            });
        }
    }
}
pub fn hit(name: &'static str, n: u64) {
    if ACTIVE.with(|a| a.get()) {
        STATS.with(|s| {
            s.borrow_mut().entry(name).or_default().0 += n;
        });
    }
}
pub fn start(enabled: bool) {
    STATS.with(|s| s.borrow_mut().clear());
    ACTIVE.with(|a| a.set(enabled));
}
pub fn finish() -> serde_json::Value {
    ACTIVE.with(|a| a.set(false));
    STATS.with(|s| {
        serde_json::to_value(
            s.borrow()
                .iter()
                .map(|(name, (count, ns))| {
                    (
                        *name,
                        serde_json::json!({"count":count,"seconds":*ns as f64/1e9}),
                    )
                })
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap()
    })
}
