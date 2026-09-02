<script lang="ts">
	import '../app.css'
	import { page } from '$app/state'
	let { data, children } = $props()
	const nav = $derived(
		data.me
			? [
					{ href: '/tasks', label: 'My tasks' },
					...(data.me.isStaff ? [{ href: '/people', label: 'People' }, { href: '/chapters', label: 'Chapters' }] : []),
					...(data.me.isGlobalAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
				]
			: []
	)
</script>

<div class="shell">
	<header class="topbar">
		<a class="brand" href="/">Pause<span>AI</span> CRM</a>
		<nav>
			{#each nav as item (item.href)}
				<a href={item.href} aria-current={page.url.pathname.startsWith(item.href) ? 'page' : undefined}>{item.label}</a>
			{/each}
		</nav>
		<div class="me">
			{#if data.me}
				<span>{data.me.name || data.me.email}</span>
				<form method="post" action="/logout"><button class="link">Sign out</button></form>
			{:else}
				<a href="/login">Sign in</a>
			{/if}
		</div>
	</header>
	<main>{@render children()}</main>
</div>
