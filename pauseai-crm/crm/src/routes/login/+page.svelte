<script lang="ts">
	import { enhance } from '$app/forms'
	let { form } = $props()
</script>

<h1>Sign in</h1>
<div class="card stack" style="max-width: 28rem">
	{#if form?.sent}
		<p>If that address is known to us, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
		{#if form.link}<p class="notice">Development mode: <a href={form.link}>open the link</a>.</p>{/if}
	{:else}
		<form method="post" use:enhance class="stack">
			<label>Email address<br /><input type="email" name="email" required autocomplete="email" style="width: 100%" /></label>
			{#if form?.message}<p class="pill danger">{form.message}</p>{/if}
			<button class="primary">Email me a sign-in link</button>
		</form>
		<p class="muted">No password. We email you a link, the same address you joined PauseAI with.</p>
	{/if}
</div>
