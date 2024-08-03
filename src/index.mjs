import * as core from "@actions/core"
import { compilePack } from "./pack.mjs"

try {
  const src = core.getInput("src")
  const dest = core.getInput("dest")
  console.log(`Compiling conpendium ${src} to ${dest}!`)
  compilePack(src, dest).then(
    () => { console.log("Done compiling compendium !") }
  )
} catch (error) {
  core.setFailed(error.message)
}
