<script lang="ts">
	let { data } = $props()
</script>

<h1>PauseAI CRM</h1>
{#if data.me}
	<p>Welcome back, {data.me.name || data.me.email}. Head to <a href="/tasks">your tasks</a>{#if data.me.isStaff} or <a href="/people">people</a>{/if}.</p>
{:else}
	<p class="muted">One place for volunteers, chapters, politicians and journalists. <a href="/login">Sign in with your email</a>.</p>
{/if}
