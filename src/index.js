// Forge function entry point for the `resolver` function module
// (content byline item + content action + space page backends).
export { handler } from './resolvers';

// Rovo action handlers live in src/rovo.js and are referenced by their
// own function modules in manifest.yml (handler: rovo.<name>).
