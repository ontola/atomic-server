<script lang="ts">
	import { enhance } from '$app/forms'
	let { data, form } = $props()
</script>

<h1>Admin</h1>
<section class="card stack">
	<h2 style="margin-top: 0">Sync sources</h2>
	{#each data.sources as s (s.source)}
		<div class="row"><strong>{s.source}</strong> <span class="muted">last success {s.lastSuccessAt ?? 'never'}</span> {#if s.lastError}<span class="pill danger">{s.lastError}</span>{/if} <code class="muted">{JSON.stringify(s.stats)}</code></div>
	{:else}
		<p class="muted">No sync has run yet.</p>
	{/each}
	<form method="post" action="?/sync" use:enhance><button class="primary">Queue Airtable sync now</button> {#if form?.queued}<span class="pill ok">queued</span>{/if}</form>
</section>

<h2>Recent jobs</h2>
<div class="table-wrap"><table>
	<thead><tr><th>Kind</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Error</th></tr></thead>
	<tbody>{#each data.jobs as j (j.id)}<tr><td>{j.kind}</td><td><span class="pill" class:ok={j.status === 'done'} class:danger={j.status === 'dead'}>{j.status}</span></td><td>{j.attempts}</td><td class="muted">{j.runAt}</td><td class="muted">{j.lastError ?? ''}</td></tr>{/each}</tbody>
</table></div>

<h2>Recent webhook events</h2>
<div class="table-wrap"><table>
	<thead><tr><th>Source</th><th>Type</th><th>Received</th><th>Processed</th><th>Error</th></tr></thead>
	<tbody>{#each data.events as e (e.id)}<tr><td>{e.source}</td><td>{e.type}</td><td class="muted">{e.receivedAt}</td><td class="muted">{e.processedAt ?? '—'}</td><td class="muted">{e.error ?? ''}</td></tr>{/each}</tbody>
</table></div>

<h2>Sandbox outbox</h2>
{#if data.outbox.length === 0}<p class="muted">No email captured in this process.</p>{:else}
<ul>{#each data.outbox as m (m.at + m.subject)}<li><span class="muted">{m.at}</span> → {m.to}: {m.subject}</li>{/each}</ul>{/if}
