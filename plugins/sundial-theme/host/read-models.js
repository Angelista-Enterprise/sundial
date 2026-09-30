// The model picker: every model each provider route lists, by route id and display name, with the
// current selection always among them (a picker that does not contain what is running is lying).
export async function readModels({ llm, current, scope }) {
  const models = []
  // Route id → the adapter's display name, so the picker can say "TensorX"
  // and not only "tensorx". Two routes can reach the same host under
  // different names (a generic adapter and Gnomon's own), and the id is the
  // only thing that tells them apart, so both travel.
  const providers = {}
  for (const provider of llm?.listProviders?.() ?? []) {
    const id = provider?.provider ?? provider?.id ?? provider?.name
    // `tensorx` is the old name of the `openai` route, kept for old threads.
    if (typeof id !== 'string' || id === '' || id === 'tensorx') continue
    providers[id] = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id
    try {
      for (const model of await llm.listModels(id)) {
        const modelId = model?.model ?? model?.id
        if (typeof modelId !== 'string' || modelId === '') continue
        models.push({
          provider: id,
          providerName: providers[id],
          model: modelId,
          ...(typeof model?.description === 'string' && model.description !== '' ? { description: model.description } : {}),
        })
      }
    } catch {
      // This provider cannot be listed right now. Not fatal, and not worth
      // telling the owner about — it simply has nothing to offer today.
    }
  }
  // The current selection always appears, even when discovery missed it: a
  // picker that does not contain what is running is lying about the state.
  if (!models.some((m) => m.provider === current.provider && m.model === current.model)) {
    models.unshift({ provider: current.provider, providerName: providers[current.provider] ?? current.provider, model: current.model })
  }
  return { current: { ...current, providerName: providers[current.provider] ?? current.provider }, scope, models }
}
