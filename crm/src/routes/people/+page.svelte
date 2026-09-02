<script lang="ts">
	let { data } = $props()
</script>

<h1>People</h1>
<form class="row" style="margin-bottom: 1rem">
	<input type="search" name="q" value={data.search} placeholder="Search name, email, city" style="min-width: 20rem" />
	<button>Search</button>
</form>
{#if data.people.length === 0}
	<div class="empty">No one in your scope matches.</div>
{:else}
	<div class="table-wrap">
		<table>
			<thead><tr><th>Name</th><th>Email</th><th>Where</th><th>Kinds</th><th>Updated</th></tr></thead>
			<tbody>
				{#each data.people as p (p.id)}
					<tr>
						<td><a href="/people/{p.id}">{p.name || '(no name)'}</a></td>
						<td class="muted">{p.email ?? '—'}</td>
						<td>{[p.city, p.country].filter(Boolean).join(', ')}</td>
						<td>{#each p.kinds as k (k)}<span class="pill">{k}</span> {/each}</td>
						<td class="muted">{new Date(p.updatedAt).toLocaleDateString()}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
