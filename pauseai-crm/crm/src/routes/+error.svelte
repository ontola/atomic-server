<script lang="ts">
	import { page } from '$app/state'
</script>

<h1>{page.status}</h1>
<p class="muted">{page.error?.message ?? 'Something went wrong.'}</p>
