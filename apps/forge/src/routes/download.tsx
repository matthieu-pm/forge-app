import { createFileRoute } from "@tanstack/react-router"

import { loadPromotedDesktopRelease } from "@/lib/desktop-release-state"

export const Route = createFileRoute("/download")({
  loader: () => loadPromotedDesktopRelease(),
  component: DownloadPage,
})

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function DownloadPage() {
  const release = Route.useLoaderData()
  const arm64 = release?.artifacts.find(
    (artifact) => artifact.architecture === "arm64" && artifact.kind === "dmg"
  )
  const x64 = release?.artifacts.find(
    (artifact) => artifact.architecture === "x64" && artifact.kind === "dmg"
  )

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f3f0e8] text-[#171714]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,#17171412_1px,transparent_1px),linear-gradient(to_bottom,#17171412_1px,transparent_1px)] [background-size:48px_48px] opacity-40"
      />
      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-7 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between border-b border-[#171714]/20 pb-5">
          <a
            href="/"
            className="inline-flex items-center gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <img src="/favicon.png" alt="" className="size-8 rounded-lg" />
            <span className="text-sm font-semibold tracking-[-0.02em]">
              Forge
            </span>
          </a>
          <span className="font-mono text-[10px] tracking-[0.2em] text-[#171714]/55 uppercase">
            macOS distribution
          </span>
        </header>

        <section className="grid flex-1 items-center gap-14 py-16 lg:grid-cols-[1.3fr_0.7fr] lg:py-24">
          <div>
            <p className="mb-6 font-mono text-xs tracking-[0.18em] text-[#b54c27] uppercase">
              Native desktop / signed &amp; notarized
            </p>
            <h1 className="max-w-4xl text-[clamp(3.75rem,9vw,8.5rem)] leading-[0.82] font-semibold tracking-[-0.075em]">
              Forge,
              <br />
              close to
              <br />
              the work.
            </h1>
            <p className="mt-9 max-w-xl text-lg leading-7 text-[#171714]/68">
              The full Forge workspace in a focused macOS app, with the same
              conversations, projects, and durable agent runs as the web.
            </p>
          </div>

          <aside className="border border-[#171714]/25 bg-[#171714] p-1 text-[#f3f0e8] shadow-[16px_16px_0_#b54c27]">
            <div className="border border-[#f3f0e8]/25 p-7 sm:p-9">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <p className="font-mono text-[10px] tracking-[0.2em] text-[#f3f0e8]/50 uppercase">
                    Current release
                  </p>
                  <p className="mt-2 text-3xl font-medium tracking-[-0.04em]">
                    {release ? `v${release.version}` : "Preparing release"}
                  </p>
                </div>
                <div className="mt-1 size-3 rounded-full bg-[#d3ff55] shadow-[0_0_0_5px_#d3ff5520]" />
              </div>

              {arm64 ? (
                <a
                  href={arm64.url}
                  className="mt-10 flex min-h-14 items-center justify-between gap-5 bg-[#d3ff55] px-5 text-sm font-semibold text-[#171714] transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d3ff55]"
                >
                  <span>Download for Apple silicon</span>
                  <span className="font-mono text-[10px] font-normal">
                    {formatBytes(arm64.sizeBytes)} ↘
                  </span>
                </a>
              ) : (
                <div className="mt-10 border border-[#f3f0e8]/20 px-5 py-4 text-sm text-[#f3f0e8]/60">
                  No promoted macOS build is available yet.
                </div>
              )}

              <div className="mt-5 flex items-center justify-between gap-4 border-t border-[#f3f0e8]/15 pt-5 text-xs text-[#f3f0e8]/55">
                <span>macOS 13 or later</span>
                {x64 ? (
                  <a
                    href={x64.url}
                    className="underline decoration-[#f3f0e8]/30 underline-offset-4 hover:text-[#f3f0e8] focus-visible:outline-2 focus-visible:outline-offset-4"
                  >
                    Intel Mac · {formatBytes(x64.sizeBytes)}
                  </a>
                ) : null}
              </div>
            </div>
          </aside>
        </section>

        <footer className="flex flex-col gap-3 border-t border-[#171714]/20 pt-5 font-mono text-[10px] tracking-[0.12em] text-[#171714]/50 uppercase sm:flex-row sm:items-center sm:justify-between">
          <span>Immutable release artifacts</span>
          <span>Automatic updates use signed ZIP builds</span>
        </footer>
      </div>
    </main>
  )
}
