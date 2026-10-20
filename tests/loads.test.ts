import { expect, test } from 'claude-code/testing'

// `claude plugin validate` and tests that import a module directly never
// load the hooks module the way the app does; mounting through the engine
// does. The kit has no `$.state` in render hooks, so a hook that ran and
// failed on that is a module that loaded: only the loader's refusal fails
// this test (a `$` handed across an import did, once).
test('the hooks module loads as the app loads it', async $ => {
  let error = ''
  try {
    await $.ui.mount({ plugin: 'session-insights', surface: 'desktop', component: 'Pane', requestId: 'session-insights', props: { title: 'Session usage', isFocused: false, bodyColumns: 100 } } as any)
  } catch (err) {
    error = (err as Error)?.message ?? String(err)
  }
  expect(error.includes('did not load')).toBe(false)
  expect(error.includes('refused')).toBe(false)
})
