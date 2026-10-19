import { libraryLUTDependencies } from './library.js'
import { applyOps } from './project.js'

function checkedResource(input, inspected) {
  if (!inspected || !Number.isInteger(inspected.size) || inspected.size < 2 || inspected.size > 256 ||
      typeof inspected.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(inspected.sourceHash)) throw new Error('Inspect a valid CUBE resource before saving the component')
  if (input.sourceHash !== undefined && input.sourceHash !== inspected.sourceHash) throw new Error(`The component LUT changed: ${input.path}. Restore the saved file or save a new component.`)
  if (input.size !== undefined && input.size !== inspected.size) throw new Error(`The component LUT size does not match inspection: ${input.path}`)
  return { type: 'lut', size: inspected.size, sourceHash: inspected.sourceHash }
}

export async function prepareLibraryOps(project, ops, inspect, assertCurrent = () => {}) {
  if (!ops.some(op => ['library_save', 'library_register', 'library_apply'].includes(op?.op))) return { ops, inputs: [] }
  let working = project
  const prepared = [], inputs = new Map()
  for (const original of ops) {
    assertCurrent()
    const op = structuredClone(original)
    const dependencies = libraryLUTDependencies(working, op)
    const resources = {}
    for (const input of dependencies) {
      const resource = checkedResource(input, await inspect(input.path))
      assertCurrent()
      const prior = inputs.get(input.path)
      if (prior && prior.sourceHash !== resource.sourceHash) throw new Error('A component LUT changed during the edit')
      inputs.set(input.path, { path: input.path, ...resource })
      resources[input.path] = resource
    }
    if (op.op === 'library_save' && dependencies.length) {
      if (op.resources && Object.keys(op.resources).some(path => !Object.hasOwn(resources, path))) throw new Error('Unreferenced LUT resource')
      op.resources = resources
    }
    prepared.push(op)
    working = applyOps(project, prepared).project
  }
  assertCurrent()
  return { ops: prepared, inputs: [...inputs.values()] }
}

// The server invokes this synchronously immediately before committing the project.
export function verifyLibraryInputs(inputs, inspect) {
  for (const input of inputs) {
    const resource = checkedResource(input, inspect(input.path))
    if (resource.size !== input.size) throw new Error(`The component LUT changed: ${input.path}`)
  }
}
