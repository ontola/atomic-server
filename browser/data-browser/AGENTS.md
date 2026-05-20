## Editing UI

When working on the data-browser, determine if you need to change or add UI, if so, read `./UI_COMPONENTS.md` for a list of existing reusable components.
Prefer the existing reusable layout, resource view, overlay, button, loading, and accessibility components listed there before building new components from scratch.

## Tech Stack

This project uses React, TypeScript, Styled Components, and the Atomic Data ecosystem.

### React Compiler

We are using the React Compiler so manual memoization is often not needed. Make sure to follow the rules of React Hooks so the compiler can do its job.
The compiler currently has some trouble compiling components that contain try/catch blocks with complex logic like if statements or async code.
Additionally the use of `finally` is not yet supported inside components.

## Localization

We are using Wuchale for localization.
It handles text extraction and translation automatically.
Use ignore comments (`/* @wc-ignore */` or `// @wc-ignore-file`) to exclude certain strings or files from being translated (For example agent system prompts).
All strings not in any function or JSX scope are automatically ignored. Strings in functions or element attributes are ignored when they do not start with a capital letter.
