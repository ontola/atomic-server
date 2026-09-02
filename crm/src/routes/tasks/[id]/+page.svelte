<script lang="ts">
	let { data } = $props()
</script>

<p><a href="/tasks">← My tasks</a></p>
<h1>{data.task.title}</h1>
<div class="card stack">
	<div class="row">
		<span class="pill">{data.task.status}</span>
		{#if data.task.dueAt}<span class="pill">due {new Date(data.task.dueAt).toLocaleDateString()}</span>{/if}
		{#if data.chapter}<span class="pill">{data.chapter.name}</span>{/if}
		{#if data.owner}<span class="muted">owner: {data.owner.name}</span>{/if}
	</div>
	{#if data.task.description}<p>{data.task.description}</p>{/if}
	{#if data.task.actionKind === 'email_mp'}
		<p class="notice">This step uses the <a href="https://pauseai.info/email-builder">email-your-representative tool</a>.</p>
	{/if}
</div>
