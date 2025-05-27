<script lang="ts">
	// Component imports and logic can go here
</script>

<svelte:head>
	<title>Atomic Server - Own Your Data, Build the Decentralized Web</title>
	<meta
		name="description"
		content="The lightweight, powerful graph database and CMS that puts you back in control of your data. Build interoperable apps that work together, not in silos."
	/>
</svelte:head>

<!-- Hero Section -->
<header class="hero">
	<div class="container">
		<div class="hero-content">
			<div class="logo-container">
				<img src="/logo.svg" alt="Atomic Server" class="logo" />
			</div>
			<h1>Atomic Server</h1>
			<p class="subtitle">Own Your Data. Build the Decentralized Web.</p>
			<p class="tagline">
				The lightweight, powerful graph database and CMS that puts you back in control of your data.
				Build interoperable apps that work together, not in silos.
			</p>
			<div class="cta-buttons">
				<a href="https://docs.atomicdata.dev/atomicserver/installation" class="btn btn-primary"
					>Get Started Free</a
				>
				<a href="https://atomicdata.dev" class="btn btn-secondary">Try Live Demo</a>
			</div>
		</div>
	</div>
</header>

<!-- Vision Section -->
<section class="vision">
	<div class="container">
		<h2>Reclaim the Web's Original Vision</h2>
		<div class="vision-grid">
			<div class="vision-card">
				<div class="icon">🌐</div>
				<h3>Decentralized by Design</h3>
				<p>
					The web was meant to be decentralized. Atomic Server brings back that vision with a
					modern, developer-friendly approach that makes data truly portable and interoperable.
				</p>
				<a href="https://docs.atomicdata.dev/motivation" class="doc-link"
					>Learn about our motivation →</a
				>
			</div>
			<div class="vision-card">
				<div class="icon">🔐</div>
				<h3>You Own Your Data</h3>
				<p>
					Stop letting big tech companies control your information. With Atomic Server, your data
					lives where you want it - on your server, under your control.
				</p>
				<a href="https://docs.atomicdata.dev/usecases/personal-data-store" class="doc-link"
					>Explore personal data stores →</a
				>
			</div>
			<div class="vision-card">
				<div class="icon">🔗</div>
				<h3>Apps That Work Together</h3>
				<p>
					Break down data silos. Build applications that seamlessly share and connect information,
					creating a truly interconnected digital ecosystem.
				</p>
				<a href="https://docs.atomicdata.dev/interoperability/rdf" class="doc-link"
					>See interoperability features →</a
				>
			</div>
		</div>
	</div>
</section>

<!-- Problem Section -->
<section class="problem">
	<div class="container">
		<h2>The Problem with Today's Web</h2>
		<div class="problem-grid">
			<div class="problem-item">
				<h3>🏢 Corporate Data Silos</h3>
				<p>
					Your photos on Google, documents on Microsoft, social data on Facebook. Each company locks
					you into their ecosystem, making it nearly impossible to move or connect your data.
				</p>
			</div>
			<div class="problem-item">
				<h3>🔒 Vendor Lock-in</h3>
				<p>
					Switching platforms means losing years of data and starting over. Companies design their
					services to trap you, not to serve you.
				</p>
			</div>
			<div class="problem-item">
				<h3>🎯 Misaligned Incentives</h3>
				<p>
					Free services aren't really free - you pay with your data and attention. Algorithms
					optimize for engagement and ad revenue, not your wellbeing.
				</p>
			</div>
			<div class="problem-item">
				<h3>⚡ Developer Frustration</h3>
				<p>
					Building interoperable apps is incredibly difficult. Every API is different, data formats
					don't match, and integration takes months instead of minutes.
				</p>
			</div>
		</div>
	</div>
</section>

<!-- Solution Section -->
<section class="solution">
	<div class="container">
		<h2>Atomic Server: The Solution</h2>
		<div class="solution-content">
			<p>
				Imagine a world where your data works everywhere. Where switching apps doesn't mean losing
				your information. Where developers can build amazing experiences by connecting existing data
				instead of recreating it.
			</p>
			<p>
				Atomic Server makes this possible by implementing the <a
					href="https://docs.atomicdata.dev/atomic-data-overview"
					class="inline-link">Atomic Data specification</a
				> - a modern approach to linked data that combines the simplicity of JSON, the connectivity of
				the semantic web, and the reliability of type safety.
			</p>
			<p>
				It's not just a database. It's the foundation for a new kind of internet - one where you
				control your data and applications work together seamlessly. <a
					href="https://docs.atomicdata.dev/when-to-use"
					class="inline-link">See when to use Atomic Data</a
				>
			</p>
		</div>
	</div>
</section>

<!-- Technical Features -->
<section class="tech-features">
	<div class="container">
		<h2>Powerful Features for Modern Applications</h2>
		<div class="tech-grid">
			<div class="tech-item">
				<div class="emoji">🚀</div>
				<h4>Lightning Fast</h4>
				<p>Sub-millisecond response times powered by Rust and optimized storage</p>
			</div>
			<div class="tech-item">
				<div class="emoji">🪶</div>
				<h4>Ultra Lightweight</h4>
				<p>8MB download, zero runtime dependencies, runs anywhere</p>
			</div>
			<div class="tech-item">
				<div class="emoji">🔎</div>
				<h4>Full-Text Search</h4>
				<p>Fuzzy search with &lt;3ms response times powered by Tantivy</p>
			</div>
			<div class="tech-item">
				<div class="emoji">🗄️</div>
				<h4>Smart Tables</h4>
				<p>Airtable-like interface with schema validation and keyboard shortcuts</p>
			</div>
			<div class="tech-item">
				<div class="emoji">📄</div>
				<h4>Collaborative Docs</h4>
				<p>Real-time document editing like Google Docs or Notion</p>
			</div>
			<div class="tech-item">
				<div class="emoji">💬</div>
				<h4>Group Chat</h4>
				<p>Built-in messaging with attachments, search, and replies</p>
			</div>
			<div class="tech-item">
				<div class="emoji">🔄</div>
				<h4>Real-time Sync</h4>
				<p>WebSocket-powered live updates across all connected clients</p>
				<a href="https://docs.atomicdata.dev/websockets" class="tech-link"
					>Learn about WebSockets →</a
				>
			</div>
			<div class="tech-item">
				<div class="emoji">💾</div>
				<h4>Complete History</h4>
				<p>Event-sourced versioning tracks every change with full audit logs</p>
				<a href="https://docs.atomicdata.dev/commits/intro" class="tech-link"
					>Explore Atomic Commits →</a
				>
			</div>
			<div class="tech-item">
				<div class="emoji">🔐</div>
				<h4>Granular Permissions</h4>
				<p>Hierarchical authorization with read/write controls</p>
				<a href="https://docs.atomicdata.dev/hierarchy" class="tech-link"
					>See authorization system →</a
				>
			</div>
			<div class="tech-item">
				<div class="emoji">🌐</div>
				<h4>Multiple Formats</h4>
				<p>Export to JSON, JSON-LD, RDF, Turtle, and more</p>
			</div>
			<div class="tech-item">
				<div class="emoji">📚</div>
				<h4>Rich Libraries</h4>
				<p>TypeScript, React, Svelte, and Rust libraries included</p>
				<a href="https://docs.atomicdata.dev/js-sdks" class="tech-link">Explore all SDKs →</a>
			</div>
			<div class="tech-item">
				<div class="emoji">🛡️</div>
				<h4>Built-in HTTPS</h4>
				<p>Automatic LetsEncrypt certificates and HTTP/2 support</p>
			</div>
		</div>
	</div>
</section>

<!-- Use Cases -->
<section class="use-cases">
	<div class="container">
		<h2>Perfect For</h2>
		<div class="use-case-grid">
			<div class="use-case">
				<h3>🏢 Organizations</h3>
				<p>
					Replace multiple SaaS tools with one unified data platform. Keep sensitive data
					on-premises while enabling seamless collaboration.
				</p>
				<a href="https://docs.atomicdata.dev/usecases/headless-cms" class="use-case-link"
					>Headless CMS use case →</a
				>
			</div>
			<div class="use-case">
				<h3>👨‍💻 Developers</h3>
				<p>
					Build interoperable apps faster. Focus on features, not data infrastructure. Use existing
					schemas or create your own.
				</p>
				<a href="https://docs.atomicdata.dev/schema/intro" class="use-case-link"
					>Learn about Atomic Schema →</a
				>
			</div>
			<div class="use-case">
				<h3>🏠 Personal Use</h3>
				<p>
					Create your own personal data store. Keep your contacts, notes, photos, and documents in
					one place you control.
				</p>
				<a href="https://docs.atomicdata.dev/usecases/personal-data-store" class="use-case-link"
					>Personal data store guide →</a
				>
			</div>
			<div class="use-case">
				<h3>🌍 Open Data</h3>
				<p>
					Publish datasets that others can easily discover, understand, and build upon. Make your
					data truly reusable.
				</p>
				<a href="https://docs.atomicdata.dev/create-json-ad" class="use-case-link"
					>Publishing data guide →</a
				>
			</div>
			<div class="use-case">
				<h3>🔬 Research</h3>
				<p>
					Collaborate on datasets with built-in versioning and provenance tracking. Ensure
					reproducibility and transparency.
				</p>
				<a href="https://docs.atomicdata.dev/commits/intro" class="use-case-link"
					>Versioning & provenance →</a
				>
			</div>
			<div class="use-case">
				<h3>🏛️ Government</h3>
				<p>
					Enable true digital sovereignty. Keep citizen data secure while promoting transparency and
					interoperability.
				</p>
				<a href="https://docs.atomicdata.dev/trust" class="use-case-link">Trust & security →</a>
			</div>
		</div>
	</div>
</section>

<!-- Features List -->
<section class="features">
	<div class="container">
		<h2>Why Choose Atomic Server?</h2>
		<div class="features-grid">
			<div class="feature">
				<h3>🎯 Developer Experience</h3>
				<p>
					Stop reinventing the wheel. Atomic Server provides <span class="highlight"
						>authentication, authorization, versioning, search, and real-time sync</span
					> out of the box. Focus on building features, not infrastructure.
				</p>
				<a href="https://docs.atomicdata.dev/js-lib/getting-started" class="feature-link"
					>Get started with JS library →</a
				>
			</div>
			<div class="feature">
				<h3>🔗 True Interoperability</h3>
				<p>
					Built on web standards with <span class="highlight"
						>URL-based properties and linked data principles</span
					>. Your data works with any Atomic Data compatible application, now and in the future.
				</p>
				<a href="https://docs.atomicdata.dev/core/concepts" class="feature-link"
					>Core concepts explained →</a
				>
			</div>
			<div class="feature">
				<h3>📊 Flexible Data Modeling</h3>
				<p>
					Create custom schemas with <span class="highlight">type safety and validation</span>.
					Extend existing models or build entirely new ones. Your data structure evolves with your
					needs.
				</p>
				<a href="https://docs.atomicdata.dev/schema/intro" class="feature-link"
					>Schema documentation →</a
				>
			</div>
			<div class="feature">
				<h3>⚡ Performance at Scale</h3>
				<p>
					Handle millions of resources with <span class="highlight"
						>indexed queries and optimized storage</span
					>. Built in Rust for maximum performance and reliability.
				</p>
				<a href="https://docs.atomicdata.dev/schema/collections" class="feature-link"
					>Query & collections →</a
				>
			</div>
			<div class="feature">
				<h3>🛡️ Security First</h3>
				<p>
					Enterprise-grade security with <span class="highlight"
						>hierarchical permissions, audit logs, and encrypted communication</span
					>. Your data stays safe and compliant.
				</p>
				<a href="https://docs.atomicdata.dev/authentication" class="feature-link"
					>Authentication guide →</a
				>
			</div>
			<div class="feature">
				<h3>🌱 Future Proof</h3>
				<p>
					Based on open standards and <span class="highlight">MIT licensed</span>. No vendor
					lock-in, no proprietary formats. Your investment is protected forever.
				</p>
				<a href="https://docs.atomicdata.dev/roadmap" class="feature-link">See our roadmap →</a>
			</div>
		</div>
	</div>
</section>

<!-- Final CTA -->
<section class="final-cta">
	<div class="container">
		<h2>Join the Decentralized Web Revolution</h2>
		<p>
			Don't wait for big tech to change. Take control of your data today and help build the internet
			we all deserve - one where users come first and data flows freely.
		</p>
		<div class="cta-buttons">
			<a href="https://docs.atomicdata.dev/atomicserver/installation" class="btn btn-primary"
				>Start Building Today</a
			>
			<a href="https://discord.gg/a72Rv2P" class="btn btn-secondary">Join Our Community</a>
		</div>
	</div>
</section>

<!-- Footer -->
<footer>
	<div class="container">
		<div class="footer-logo">
			<img src="/logo.svg" alt="Atomic Server" class="footer-logo-img" />
		</div>
		<div class="footer-links">
			<a href="https://docs.atomicdata.dev">Documentation</a>
			<a href="https://github.com/atomicdata-dev/atomic-server">GitHub</a>
			<a href="https://discord.gg/a72Rv2P">Discord</a>
			<a href="https://atomicdata.dev">Demo</a>
			<a href="https://crates.io/crates/atomic-server">Download</a>
		</div>
		<p>&copy; 2024 Atomic Data. MIT Licensed. Built with ❤️ for a better web.</p>
	</div>
</footer>

<style>
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(body) {
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
		line-height: 1.6;
		color: #333;
		background: #fff;
	}

	.container {
		max-width: 1200px;
		margin: 0 auto;
		padding: 0 20px;
	}

	/* Header */
	.hero {
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
		padding: 2rem 0;
		text-align: center;
	}

	.logo-container {
		margin-bottom: 2rem;
	}

	.logo {
		height: 80px;
		width: auto;
		filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
	}

	.hero-content h1 {
		font-size: 3.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
		text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
	}

	.hero-content .subtitle {
		font-size: 1.5rem;
		margin-bottom: 2rem;
		opacity: 0.9;
	}

	.hero-content .tagline {
		font-size: 1.2rem;
		margin-bottom: 3rem;
		max-width: 800px;
		margin-left: auto;
		margin-right: auto;
	}

	.cta-buttons {
		display: flex;
		gap: 1rem;
		justify-content: center;
		flex-wrap: wrap;
	}

	.btn {
		display: inline-block;
		padding: 1rem 2rem;
		border-radius: 8px;
		text-decoration: none;
		font-weight: 600;
		transition: all 0.3s ease;
		border: 2px solid transparent;
	}

	.btn-primary {
		background: #ff6b6b;
		color: white;
	}

	.btn-primary:hover {
		background: #ff5252;
		transform: translateY(-2px);
	}

	.btn-secondary {
		background: transparent;
		color: white;
		border-color: white;
	}

	.btn-secondary:hover {
		background: white;
		color: #667eea;
	}

	/* Vision Section */
	.vision {
		padding: 5rem 0;
		background: #f8f9fa;
	}

	.vision h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
		color: #2c3e50;
	}

	.vision-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 3rem;
		margin-bottom: 3rem;
	}

	.vision-card {
		background: white;
		padding: 2rem;
		border-radius: 12px;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
		text-align: center;
	}

	.vision-card .icon {
		font-size: 3rem;
		margin-bottom: 1rem;
	}

	.vision-card h3 {
		font-size: 1.5rem;
		margin-bottom: 1rem;
		color: #2c3e50;
	}

	.doc-link {
		color: #667eea;
		text-decoration: none;
		font-weight: 600;
	}

	/* Features Section */
	.features {
		padding: 5rem 0;
	}

	.features h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
		color: #2c3e50;
	}

	.features-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
		gap: 2rem;
	}

	.feature {
		padding: 1.5rem;
		border-left: 4px solid #667eea;
		background: #f8f9fa;
		border-radius: 8px;
	}

	.feature h3 {
		color: #667eea;
		margin-bottom: 0.5rem;
		font-size: 1.2rem;
	}

	.feature .highlight {
		color: #ff6b6b;
		font-weight: 600;
	}

	.feature-link {
		color: #667eea;
		text-decoration: none;
		font-size: 0.9rem;
	}

	/* Problem Section */
	.problem {
		padding: 5rem 0;
		background: linear-gradient(135deg, #ff6b6b 0%, #ffa726 100%);
		color: white;
	}

	.problem h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
	}

	.problem-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 2rem;
	}

	.problem-item {
		background: rgba(255, 255, 255, 0.1);
		padding: 2rem;
		border-radius: 12px;
		backdrop-filter: blur(10px);
	}

	.problem-item h3 {
		margin-bottom: 1rem;
		font-size: 1.3rem;
	}

	/* Solution Section */
	.solution {
		padding: 5rem 0;
		background: #2c3e50;
		color: white;
	}

	.solution h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
	}

	.solution-content {
		max-width: 800px;
		margin: 0 auto;
		text-align: center;
	}

	.solution-content p {
		font-size: 1.2rem;
		margin-bottom: 2rem;
		line-height: 1.8;
	}

	.inline-link {
		color: #ff6b6b;
		text-decoration: none;
		font-weight: 600;
	}

	/* Technical Features */
	.tech-features {
		padding: 5rem 0;
		background: #f8f9fa;
	}

	.tech-features h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
		color: #2c3e50;
	}

	.tech-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.5rem;
	}

	.tech-item {
		background: white;
		padding: 1.5rem;
		border-radius: 8px;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	.tech-item .emoji {
		font-size: 2rem;
		margin-bottom: 0.5rem;
	}

	.tech-item h4 {
		color: #667eea;
		margin-bottom: 0.5rem;
	}

	.tech-link {
		color: #667eea;
		text-decoration: none;
		font-size: 0.9rem;
	}

	/* Use Cases */
	.use-cases {
		padding: 5rem 0;
	}

	.use-cases h2 {
		font-size: 2.5rem;
		text-align: center;
		margin-bottom: 3rem;
		color: #2c3e50;
	}

	.use-case-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 2rem;
	}

	.use-case {
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
		padding: 2rem;
		border-radius: 12px;
		text-align: center;
	}

	.use-case h3 {
		margin-bottom: 1rem;
		font-size: 1.4rem;
	}

	.use-case-link {
		color: rgba(255, 255, 255, 0.8);
		text-decoration: none;
		font-size: 0.9rem;
	}

	/* CTA Section */
	.final-cta {
		padding: 5rem 0;
		background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
		color: white;
		text-align: center;
	}

	.final-cta h2 {
		font-size: 2.5rem;
		margin-bottom: 2rem;
	}

	.final-cta p {
		font-size: 1.2rem;
		margin-bottom: 3rem;
		max-width: 600px;
		margin-left: auto;
		margin-right: auto;
	}

	/* Footer */
	footer {
		background: #1a1a1a;
		color: white;
		padding: 3rem 0;
		text-align: center;
	}

	.footer-logo {
		margin-bottom: 2rem;
	}

	.footer-logo-img {
		height: 60px;
		width: auto;
		opacity: 0.8;
	}

	.footer-links {
		display: flex;
		justify-content: center;
		gap: 2rem;
		margin-bottom: 2rem;
		flex-wrap: wrap;
	}

	.footer-links a {
		color: #ccc;
		text-decoration: none;
	}

	.footer-links a:hover {
		color: white;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.logo {
			height: 60px;
		}

		.footer-logo-img {
			height: 45px;
		}

		.hero-content h1 {
			font-size: 2.5rem;
		}

		.hero-content .subtitle {
			font-size: 1.2rem;
		}

		.cta-buttons {
			flex-direction: column;
			align-items: center;
		}

		.btn {
			width: 100%;
			max-width: 300px;
		}
	}
</style>
