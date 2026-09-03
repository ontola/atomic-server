<script lang="ts">
	import { enhance } from '$app/forms'
	let { data } = $props()
	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'no deadline')
	const overdue = (iso: string | null) => iso !== null && new Date(iso) < new Date()
</script>

<h1>My tasks</h1>
{#if data.tasks.length === 0}
	<div class="empty">Nothing on your plate. Your chapter lead will send you a next step soon. In the meantime: <a href="https://pauseai.info/email-builder">email your representative</a>.</div>
{:else}
	<div class="stack">
		{#each data.tasks as task (task.id)}
			<div class="card row" style="justify-content: space-between">
				<div>
					<strong><a href="/tasks/{task.id}">{task.title}</a></strong>
					{#if task.escalationLevel > 0}<span class="pill warn">escalated</span>{/if}
					<div class="muted">
						<span class:danger={overdue(task.dueAt)} class="pill">{fmt(task.dueAt)}</span>
						{#if task.description}<span> · {task.description}</span>{/if}
					</div>
				</div>
				<form method="post" action="?/complete" use:enhance>
					<input type="hidden" name="id" value={task.id} />
					<button class="primary">Done</button>
				</form>
			</div>
		{/each}
	</div>
{/if}
