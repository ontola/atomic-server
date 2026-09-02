<script lang="ts">
	let { data } = $props()
</script>

<p><a href="/people">← People</a></p>
<h1>{data.person.name || '(no name)'}</h1>
<div class="row" style="margin-bottom: 1rem">
	{#each data.person.kinds as k (k)}<span class="pill">{k}</span>{/each}
	{#if data.profile}<span class="pill ok">{data.profile.stage}</span>{/if}
	<span class="muted">visibility: {data.tier}</span>
</div>

<div class="stack" style="grid-template-columns: 1fr 1fr; display: grid; gap: 1rem; align-items: start">
	<section class="card">
		<h2 style="margin-top: 0">Contact</h2>
		<dl>
			<dt class="muted">Email</dt><dd>{data.person.email ?? '—'}</dd>
			<dt class="muted">Phone</dt><dd>{data.person.phone ?? '—'}</dd>
			<dt class="muted">Location</dt><dd>{[data.person.city, data.person.country].filter(Boolean).join(', ') || '—'}</dd>
			<dt class="muted">Languages</dt><dd>{data.person.languages.join(', ') || '—'}</dd>
		</dl>
		{#if data.identities.length}
			<h2>Linked accounts</h2>
			{#each data.identities as i (i.provider + i.handle)}
				<div><span class="pill">{i.provider}</span> {i.handle} {#if i.verified}<span class="pill ok">verified</span>{:else}<span class="pill warn">claimed</span>{/if}</div>
			{/each}
		{/if}
	</section>
	<section class="card">
		<h2 style="margin-top: 0">Involvement</h2>
		{#each data.memberships as m (m.chapter)}
			<div>{m.chapter} <span class="pill">{m.role}</span> <span class="pill">{m.status}</span></div>
		{:else}
			<p class="muted">No chapter yet.</p>
		{/each}
		{#if data.profile}
			<dl>
				<dt class="muted">Intent</dt><dd>{data.profile.intent ?? '—'}</dd>
				<dt class="muted">Hours per week</dt><dd>{data.profile.weeklyHours ?? '—'}</dd>
				<dt class="muted">Skills</dt><dd>{data.profile.skills.join(', ') || '—'}</dd>
			</dl>
		{/if}
		{#if data.consents.length}
			<h2>Consents</h2>
			{#each data.consents as c (c.purpose)}
				<div><span class="pill" class:ok={c.granted} class:danger={!c.granted}>{c.purpose}: {c.granted ? 'yes' : 'no'}</span></div>
			{/each}
		{/if}
	</section>
</div>

<h2>Timeline</h2>
{#if data.timeline.length === 0}
	<div class="empty">No interactions recorded yet.</div>
{:else}
	<ul class="timeline">
		{#each data.timeline as i (i.id)}
			<li><time>{new Date(i.at).toLocaleString()}</time><div><span class="pill">{i.kind}</span> {#if i.channel}<span class="muted">{i.channel}</span>{/if} {i.subject ?? ''}</div></li>
		{/each}
	</ul>
{/if}
