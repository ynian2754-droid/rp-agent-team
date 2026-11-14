export const NATIVE_PRESET_TOOLS = 'native:preset'

// Denial names, not dependencies: members use Team-owned data tools. Unknown
// future product tools are also refused by the execution guard below.
export const HOST_PRODUCT_TOOLS = Object.freeze([
  'eleckoi_glob_setting_files', 'eleckoi_grep_setting_files', 'eleckoi_read_setting_files', 'eleckoi_apply_setting_patch',
  'eleckoi_glob_variables', 'eleckoi_grep_variables', 'eleckoi_read_variables', 'eleckoi_apply_variable_patch',
  'eleckoi_read_uploaded_file', 'update_roleplay_plan'
])
export function isHostProductTool(name) { return name?.startsWith('eleckoi_') || name === 'update_roleplay_plan' }

/** Applied to primary, nested and restored Agent scopes, even when no product
 * schema is present yet. Trusted external tools never grant product access. */
export function restrictMemberTools(agentCtx, { member, rootGroups, productDisabled, scheduled, submitOnly }) {
  const allowed = allowedGroupsForAgent(member, rootGroups, productDisabled)
  const isDenied = declaration => {
    const name = declaration?.name ?? declaration?.function?.name ?? ''
    if (!name) return false
    if (submitOnly) return name !== 'rp_team_submit_internal'
    if (name.startsWith('rp_team_')) return !scheduled
    if (isHostProductTool(name)) return true
    return !allowed.has(capabilityForDeclaration(declaration))
  }
  const stopFilter = agentCtx.tools.restrictDeclarations(declaration => !isDenied(declaration))
  const stopGuard = agentCtx.tools.guard(execution => isDenied({ name: execution.name })
    ? `Tool "${execution.name}" is not authorized by this agent's capabilities.` : undefined)
  return () => { stopGuard(); stopFilter() }
}

export const CAPABILITIES = [
  ['builtin:web', 'Web search'], ['builtin:setting-library', 'Setting library'], ['builtin:variables', 'Story variables'],
  ['builtin:creator', 'Creator tools'], ['builtin:workspace', 'Workspace'], ['builtin:workflow', 'Workflow'],
  ['builtin:roleplay-workflow', 'Roleplay plan'], ['builtin:mcp-resources', 'MCP resources'],
  ['builtin:plugin-discovery', 'Plugin discovery'], ['builtin:collaboration', 'Collaboration'],
  [NATIVE_PRESET_TOOLS, 'Native preset functions']
]

export const MANAGED_CAPABILITIES = new Set(['builtin:web', 'builtin:setting-library', 'builtin:variables', 'builtin:workflow', 'builtin:roleplay-workflow'])
export const TRUSTED_CAPABILITIES = new Set(['builtin:creator', 'builtin:workspace', 'builtin:mcp-resources', 'builtin:plugin-discovery', 'builtin:collaboration', 'builtin:other', NATIVE_PRESET_TOOLS])

export function allowedGroupsForAgent(agent, rootGroups, productDisabled) {
  const explicit = new Set(agent.capabilities.filter(item => item.enabled).map(item => item.id))
  const selected = new Set(agent.capabilities.length ? explicit : rootGroups.filter(id => !productDisabled.has(id)))
  for (const group of [...selected]) {
    if (TRUSTED_CAPABILITIES.has(group) || group.startsWith('extension:') || group.startsWith('mcp:')) {
      if (!agent.execution.trustedTools.includes(group)) selected.delete(group)
    }
    if (productDisabled.has(group)) selected.delete(group)
  }
  selected.add('rp-team')
  return selected
}

export function toolGroups(declarations) { return new Set(declarations.map(capabilityForDeclaration).filter(Boolean)) }

export function capabilityForDeclaration(declaration) {
  const name = declaration?.name ?? declaration?.function?.name ?? ''
  if (declaration?.type === 'web_search' || ['web_search', 'web_fetch'].includes(name)) return 'builtin:web'
  if (/^(?:eleckoi_glob_setting_files|eleckoi_grep_setting_files|eleckoi_read_setting_files|eleckoi_apply_setting_patch)$/u.test(name)) return 'builtin:setting-library'
  if (/^(?:eleckoi_glob_variables|eleckoi_grep_variables|eleckoi_read_variables|eleckoi_apply_variable_patch)$/u.test(name)) return 'builtin:variables'
  if (/^(?:shell_command|bash|pwsh|read|edit|write|exec_command|write_stdin|apply_patch|request_permissions)$/u.test(name)) return 'builtin:workspace'
  if (/^(?:todo_write|get_goal|create_goal|update_goal|job_output|job_list|job_kill|skill|workflow)$/u.test(name)) return 'builtin:workflow'
  if (name === 'update_roleplay_plan') return 'builtin:roleplay-workflow'
  if (/^(?:list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/u.test(name)) return 'builtin:mcp-resources'
  if (/^(?:request_plugin_install|list_available_plugins_to_install)$/u.test(name)) return 'builtin:plugin-discovery'
  if (/^(?:subagent|subagent_fork|send_message|interrupt_agent|list_agents)$/u.test(name)) return 'builtin:collaboration'
  if (declaration?.type === 'namespace' || name === 'namespace') {
    const namespace = declaration.name ?? name
    if (namespace.startsWith('mcp__')) return `mcp:${namespace.slice(5)}`
    return `extension:${namespace}`
  }
  if (name && declaration?.type !== 'namespace') return NATIVE_PRESET_TOOLS
  return 'builtin:other'
}

export function capabilityAvailableInSnapshot(id, snapshot) {
  if (id === 'builtin:variables' && snapshot?.variablesEnabled === false) return false
  if (id === 'builtin:setting-library' && snapshot?.settingLibraryEnabled === false) return false
  return true
}

export function capabilityLabel(id) {
  const known = CAPABILITIES.find(([candidate]) => candidate === id)?.[1]
  if (known) return known
  if (id.startsWith('mcp:')) return `MCP · ${id.slice(4)}`
  if (id.startsWith('extension:')) return `Extension · ${id.slice(10)}`
  return id
}
