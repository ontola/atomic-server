# OpenCode Configuration

This directory contains the OpenCode agent configurations for the atomic-server project.

## Structure

- `opencode.json` (root) - Main configuration with schema reference and provider settings
- `.opencode/agent/*.md` - Individual agent definitions

## Agents

All agents have been configured with simple YAML frontmatter:

- **ai-engineer** - ML features, LLM integration, and intelligent automation
- **architect** - Analyzes code, designs solutions, writes ADRs
- **backend-architect** - APIs, server logic, databases, and scalable backends
- **debugger** - Rust applications, WebAssembly, streaming pipelines
- **developer** - Implements specs with tests
- **development-observer** - Verifies work meets requirements and standards
- **devops-automator** - CI/CD, cloud infrastructure, monitoring, deployment
- **frontend-developer** - UI components, state management, frontend performance
- **mobile-app-builder** - Native iOS/Android apps and React Native
- **overseer** - System quality, security compliance, architecture reviews
- **quality-reviewer** - Code review for security, data loss, performance
- **rapid-prototyper** - Quick MVPs, prototypes, and proof-of-concepts
- **rust-code-reviewer** - Rust code correctness, safety, idiomatic patterns
- **rust-performance-expert** - Rust optimization, high-performance algorithms, SIMD
- **technical-writer** - Documentation after feature completion

## Usage

OpenCode will automatically discover these agents. No additional configuration needed.
