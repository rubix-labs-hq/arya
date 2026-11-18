// The ops a pending assistant preview applies. The preview card lists their changes and the
// viewer can draw their result, so both read the same ops from here.

/** The proposal's ops, led by an import of the media it brings that the project does not have yet. */
export function proposalOps(project, proposal) {
  const imports = Object.fromEntries(Object.entries(proposal?.assets ?? {}).filter(([src]) => !project?.assets?.[src]))
  const ops = proposal?.ops ?? []
  return Object.keys(imports).length ? [{ op: 'import', assets: imports }, ...ops] : ops
}
