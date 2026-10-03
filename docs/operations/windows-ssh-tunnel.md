# Maintaining an external SSH tunnel on Windows

For a saved direct connection that uses an external SSH forward, run
`scripts/ssh-tunnel-supervisor.mjs` with Node 24 instead of an unmonitored `ssh -L`:

```powershell
node scripts/ssh-tunnel-supervisor.mjs --target workstation --local-port 13773 --lan-addresses 192.168.1.10 --log-file "$env:USERPROFILE/.ssh/t3-tunnel.log"
```

Use your SSH alias and LAN addresses. The alias supplies credentials and its
configured fallback route. Optional `--environment-id` checks that the forwarded
server is the intended environment; `--remote-port` defaults to 3773. Keep the
saved T3 connection pointed at the chosen local port.

The supervisor checks the T3 environment endpoint every ten seconds and restarts
its own SSH process tree after three consecutive failures. It also returns from
the fallback route after three consecutive successful LAN probes. This briefly
reconnects the client. A reachable SSH port alone cannot prove the forwarded T3
server is healthy.

For an existing scheduled tunnel task, point its launcher at this script, run the
task hidden, and stop its previous tunnel before starting the replacement. Keep
only one supervisor per local port. Stop only the task and processes it owns.
Logs rotate at 1 MiB when `--log-file` is provided.
