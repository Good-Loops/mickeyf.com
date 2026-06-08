Contract-first API documentation for **mickeyf.com**, covering frontend and backend
TypeScript code that is intended to be reused, reasoned about, and depended on.

## What this documentation is
- The **source of truth** for exported types, functions, classes, and modules.
- Focused on **non-UI code**: engines, helpers, utilities, services, game logic, and shared models.
- Generated directly from TypeScript with no runtime behavior changes.

## What is intentionally excluded
- Pages
- UI components
- React hooks
- Entry points (`main.tsx` and `App.tsx`)

These are considered implementation details, not public contracts.

## How to navigate
- Use the **sidebar** to browse modules by domain.
- Start with shared utilities and core engines if you’re new to the codebase.

## Architectural notes
- Public APIs prefer **named exports** for clarity and stability.
- Types and invariants live close to the code they describe.
- Documentation favors intent and contracts over implementation narration.

## Links
- Website: https://mickeyf.com
- Repository: https://github.com/Good-Loops/mickeyf.com
