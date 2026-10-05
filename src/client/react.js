// The host owns React. ModuleLoader hands its instance to entry.jsx, which binds it
// here before any component renders; JSX in this package compiles to React.createElement.
export let React = null

export function bindHostReact(instance) {
  React = instance
}
