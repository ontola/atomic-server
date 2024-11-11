export async function register() {
  const ontologies = await import('@/ontologies');

  // Registers your ontologies with the store on the server
  ontologies.initOntologies();
}
