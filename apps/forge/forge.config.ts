import { join, resolve } from "node:path"

import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { config as loadEnvironment } from "dotenv"
import type { ForgeConfig } from "@electron-forge/shared-types"

const repositoryRoot = resolve(import.meta.dirname, "../..")
loadEnvironment({ path: resolve(repositoryRoot, ".env"), quiet: true })
loadEnvironment({
  path: resolve(repositoryRoot, ".env.local"),
  override: true,
  quiet: true,
})

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY
const appleId = process.env.APPLE_ID
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
const appleTeamId = process.env.APPLE_TEAM_ID

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "com.forge.desktop",
    appCategoryType: "public.app-category.productivity",
    appCopyright: `Copyright © ${new Date().getFullYear()} Forge`,
    asar: true,
    executableName: "Forge",
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
    },
    icon: "desktop/assets/forge",
    ignore: [
      /^\/(?!\.electron-build(?:\/|$)|desktop\/assets(?:\/|$)|package\.json$)/,
    ],
    osxSign: signingIdentity
      ? {
          identity: signingIdentity,
        }
      : undefined,
    osxNotarize:
      signingIdentity && appleId && appleIdPassword && appleTeamId
        ? {
            appleId,
            appleIdPassword,
            teamId: appleTeamId,
          }
        : undefined,
    overwrite: true,
    protocols: [
      {
        name: "Forge links",
        schemes: ["forge", "com.forge.desktop"],
      },
    ],
  },
  rebuildConfig: {},
  hooks: {
    generateAssets: async () => {
      const { execa } = await import("execa")
      await execa("bun", ["run", "desktop:build"], { stdio: "inherit" })
    },
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== "darwin" || signingIdentity) return

      const { execa } = await import("execa")
      for (const outputPath of result.outputPaths) {
        await execa("codesign", [
          "--force",
          "--deep",
          "--sign",
          "-",
          join(outputPath, "Forge.app"),
        ])
      }
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      config: {},
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        "code-sign": signingIdentity
          ? {
              identifier: "com.forge.desktop.dmg",
              "signing-identity": signingIdentity,
            }
          : undefined,
        format: "ULFO",
        icon: "desktop/assets/forge.icns",
        overwrite: true,
      },
    },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config
