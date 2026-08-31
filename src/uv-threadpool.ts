// libuv sizes its threadpool from UV_THREADPOOL_SIZE at first use, so this
// must be imported before anything that touches async fs. The go-cache scans
// need more than the default 4 threads to overlap I/O on cold sticky disks.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}
