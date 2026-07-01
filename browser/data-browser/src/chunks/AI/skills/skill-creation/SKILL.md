# Create an Agent Skill

This skill guides you through the process of creating a new skill for the Atomic Agent. Skills should be well-scoped, grounded in real expertise, and focused on project-specific context rather than general knowledge.

In the Atomic Agent, skills are created using the `create_skill` tool. A skill consists of a `name`, a short `description`, the main markdown `content` (which acts as the instructions), and optional `references` (an array of supplementary files with a `path` and `content`).

There are two primary workflows for creating a skill. Choose the one that matches the user's request.

## Flow 1: Distill from a completed task

Use this flow when the user has just guided you through a task (with explanations and corrections) and asks you to save that process as a skill.

1. **Analyze the recent task execution**:
   - Review the steps that actually worked.
   - Note the corrections the user made to steer your approach.
   - Look at the specific input and output formats used.
   - Identify project-specific facts, conventions, or constraints provided by the user.
2. **Synthesize the skill**:
   - Extract the reusable pattern into a concrete procedure.
   - Include a "Gotchas" section for the specific mistakes you made or edge cases the user pointed out.
3. **Draft the Skill**:
   - Present the draft of the skill (name, description, and content) to the user for review before creating it.
   - Ask if there are any other edge cases or default behaviors they want to encode.

## Flow 2: Create from a description

Use this flow when the user starts by describing a skill they want you to create.

1. **Clarify requirements**:
   - Do NOT immediately generate the skill if the domain context is vague.
   - Ask questions to clarify:
     - What are the specific tools, APIs, or project conventions to use?
     - Are there any common edge cases or "Gotchas" to watch out for?
     - What is the expected input and output format?
     - Are there multiple ways to do this? (If so, ask what the _default_ should be).
2. **Draft the Skill**:
   - Once the context is clear, draft the skill applying the best practices below.
   - Present it to the user for review before calling the `create_skill` tool.

## Best Practices for Writing Skill Content

When writing the `content` of the skill, strictly adhere to these principles:

### 1. Spend Context Wisely

- **Add what the agent lacks, omit what it knows**: Focus exclusively on project-specific conventions, domain procedures, and non-obvious edge cases. Do not include generic advice (e.g., "handle errors appropriately" or explaining basic concepts like what a database migration does).
- **Design coherent units**: Scope the skill to a single, coherent unit of work.

### 2. Calibrate Control

- **Match specificity to fragility**: Give the agent freedom (explain _why_) when tasks tolerate variation. Be highly prescriptive (e.g., providing exact tool calls) for fragile sequences.
- **Provide defaults, not menus**: When multiple tools could work, pick a clear default and briefly mention the fallback.
- **Favor procedures over declarations**: Teach the agent _how to approach_ a class of problems rather than exactly what to produce for a single instance.

### 3. Use Effective Patterns

- **Gotchas sections**: Include a list of concrete environment-specific facts or corrections to prevent common mistakes.
- **Templates**: Provide concrete markdown or code templates for specific output formats.
- **Checklists**: For multi-step workflows, provide an explicit checklist with progress markers.
- **Progressive disclosure**: Keep the main skill `content` concise (under 500 lines). If more detail is needed, include supplementary text in the `references` property when calling `create_skill`, and instruct the agent to read those reference paths only when certain conditions are met (using the `read_skill_reference` tool).

## Structure of the Skill Content

Your generated skill `content` should generally follow this markdown structure:

```markdown
# [Skill Title]

[Brief general explanation of things the agent needs to know to perform the task.]

## Workflow / Procedure

1. Step one
2. Step two...

## Templates / Checklists (if applicable)

[Output templates or explicit checklists]

## Gotchas (if applicable)

- [Specific edge case 1]
- [Specific project convention]
```

## Final Steps

Think of a good description for the skill.
The description should tell the agent when to use the skill.
Do not make it to generic. We don't want the agent to use the skill when it is not needed.

Once the user approves the draft, call the `create_skill` tool with the finalized `name`, `description`, `content`, and any optional `references`.

After successfully creating the skill, remind the user that the best way to refine a skill is to test it on a real task and feed the results (successes and failures) back into the skill.
