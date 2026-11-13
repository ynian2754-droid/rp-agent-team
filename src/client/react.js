// The host owns React. ModuleLoader hands its instance to entry.jsx, which binds it
// here before any component renders; JSX in this package compiles to React.createElement.
export let React = null

export function bindHostReact(instance) {
  React = instance
}

// Native-ledger components share the same ModuleLoader React as the editor.
export { React as default }
export const createElement = (...args) => React.createElement(...args)
export const useCallback = (...args) => React.useCallback(...args)
export const useEffect = (...args) => React.useEffect(...args)
export const useId = (...args) => React.useId(...args)
export const useLayoutEffect = (...args) => React.useLayoutEffect(...args)
export const useMemo = (...args) => React.useMemo(...args)
export const useRef = (...args) => React.useRef(...args)
export const useState = (...args) => React.useState(...args)
export const useSyncExternalStore = (...args) => React.useSyncExternalStore(...args)
