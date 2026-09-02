<script lang="ts">
	let { data } = $props()
</script>

<h1>Chapters</h1>
<div class="table-wrap">
	<table>
		<thead><tr><th>Chapter</th><th>Kind</th><th>Members</th><th>Access</th></tr></thead>
		<tbody>
			{#each data.chapters as c (c.id)}
				<tr>
					<td style="padding-left: {0.8 + c.depth * 1.25}rem">{c.name}{#if !c.active} <span class="pill warn">inactive</span>{/if}</td>
					<td class="muted">{c.kind}</td>
					<td>{c.members}</td>
					<td>{#if c.mine}<span class="pill ok">admin</span>{/if}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
