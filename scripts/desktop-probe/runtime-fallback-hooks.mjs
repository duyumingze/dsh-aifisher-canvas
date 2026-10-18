import { pathToFileURL } from 'node:url'

// Fall back to the packaged DSH runtime's own node_modules for specifiers that
// plain resolution cannot find, so the extracted Desktop Host entry can import
// its own dependencies while profile bundles still resolve from the profile.
const PARENT = pathToFileURL(
  'D:\\Program Files\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
).href

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')
    if (!bare) throw error
    return nextResolve(specifier, { ...context, parentURL: PARENT })
  }
}
