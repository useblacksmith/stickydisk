// libuv sizes its threadpool from UV_THREADPOOL_SIZE at first use, so this
// must be imported before anything that touches async fs. The go-cache scans
// need more than the default 4 threads to overlap I/O on cold sticky disks.
// 16 came from sweeping 4/8/16/32/64 against real multi-GB Go caches on
// 2/4/8-vcpu runners: it was best or near-best everywhere (the work is
// I/O-bound, so vcpu count barely matters), and larger pools showed no gain.
// Full methodology and results:
// https://github.com/useblacksmith/stickydisk/pull/75#issuecomment-5478135682
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}
