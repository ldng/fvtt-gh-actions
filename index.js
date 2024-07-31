import {core} from '@actions/core'
import {github} from '@actions/github'

import {compilePack} from "./pack.mjs"


try {
  const src = core.getInput('src');
  const dest = core.getInput('dest');
  console.log(`Compiling ${src} to ${dest}!`);
  await compilePack(src, dest);
  // Get the JSON webhook payload for the event that triggered the workflow
  const payload = JSON.stringify(github.context.payload, undefined, 2)
  console.log(`The event payload: ${payload}`);
} catch (error) {
  core.setFailed(error.message);
}
