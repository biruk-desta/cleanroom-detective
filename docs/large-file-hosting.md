# Large-file workspace and Cloudflare setup

## Current status

The private, disk-backed workspace is implemented and tested locally. The public GitHub Pages demo still uses the original browser-only 1 MB / 5,000-row limit. Cloudflare R2 is **not activated or connected**, and the large-file workspace is **not publicly deployed**.

The Cloudflare connector successfully authenticated the owner's Ghost account on September 18, 2026. R2's dashboard requires adding a subscription: $0 due now, with automatic billing above the included allowance. Activation is awaiting the owner's choice. No paid plan or R2 subscription was enabled. Oracle is no longer being pursued.

## Verified local capacity

`npm run benchmark:large` generated a synthetic CSV and exercised the actual HTTP service, chunked upload, background import, checks, paged review, a repair, updated download, undo, and original download.

| Measurement | Result on this Mac, Node 24.2.0 |
| --- | --- |
| Original bytes | 1,181,116,214 (1.18 GB / 1.10 GiB) |
| Data records | 1,225,106 |
| Updated download bytes | 1,182,341,322 |
| Peak process RSS, including worker threads | 526,598,144 bytes (502 MiB) |
| Complete workflow elapsed | 167 seconds |
| Original recovery | SHA-256 matches the input exactly |

The synthetic file has five columns, mostly ordinary rows and one supported quantity repair. This proves this local workflow for that file shape; it does not establish dense-finding throughput, company-wide concurrency, R2 network performance, or capacity for every CSV. The generated files were removed. No company data was transmitted.

## Run locally

Use Node 24 or later. The tested runtime is 24.2.0.

```sh
npm ci
npm run build:server
npm run account:large -- owner
npm run serve:large
```

Open `http://localhost:8080`. The account command writes random credentials to `.large-data/owner-access.txt` with private file permissions; password hashes are stored in `.large-data/users.json`. These files and all job data are gitignored. Create a separate account for each person, then restart the service to load it. Do not share an account between people who need file isolation.

Configuration:

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `8080` |
| `HOST` | `127.0.0.1` |
| `PUBLIC_ORIGIN` | `http://localhost:8080`; exact browser origin for cookies and CSRF protection |
| `CLEANROOM_DATA_DIR` | `.large-data` |
| `CLEANROOM_USERS_FILE` | `.large-data/users.json` |
| `MAX_UPLOAD_BYTES` | 2 GiB upper bound; actual admission also requires working disk space |
| `MAX_RESERVED_BYTES` | 60 GiB total local reservation |
| `RETENTION_HOURS` | 24 hours, followed by automatic deletion when the job is idle |

Upload chunks are 8 MiB. The processor admits work conservatively at 20 times input size plus 128 MiB per file to cover input, database, journal, and temporary space. SQLite is limited separately. A file can be rejected because working space is unavailable even when its upload size fits. One background task runs at a time; up to five retained files are allowed per account. CSV limits include 20 million records, 200 columns and 4,000 characters per cell.

Original bytes are retained untouched. Working cells stay strings. Paged suggestions carry evidence fingerprints, server-validated changes, before-value checks and dependencies. Changes and undo are atomic. Duplicate groups compare all rows; numeric checks use the full valid cohort and exact IQR interpolation. Exports stream instead of building a whole-file string.

## Cloudflare path still to finish

The $0-compute option uses this computer for processing; it must remain online. R2 provides private object storage and transfer, not a Node/SQLite processor. Cloudflare Containers require a paid plan, so they are outside the current budget.

1. Obtain the owner's explicit choice about R2 activation and usage-based billing. The Standard allowance is 10 GB-month, 1 million Class A operations and 10 million Class B operations monthly, with free egress. This is an allowance, not a hard spending cap.
2. Create a private, dedicated R2 bucket, narrowly scoped credentials, short retention/lifecycle cleanup and project storage reservations below the account allowance. Check other account usage too.
3. Implement and test direct browser-to-R2 multipart uploads through short-lived presigned URLs. Keep ownership, part size, resumable hashes, original size verification and cleanup in the existing authenticated Node API. Stream input from R2 into the local processor and export results back to R2.
4. Expose the UI and small authenticated API through a Cloudflare Tunnel. A stable named Tunnel needs an existing Cloudflare domain. A Quick Tunnel is only a temporary friends/hackathon preview with a changing URL and no uptime guarantee. Large file transfer must go through R2, not a public free Tunnel.
5. Verify a file above 1 GB through the actual deployed storage path before adding the workspace link to the shared GitHub website.

Do not claim cloud storage or large public uploads are ready until steps 2–5 have actually passed. The current local service does not yet contain an R2 adapter.

## Validation commands

```sh
npm test
npm run lint:app
npx tsc --noEmit
npm run build:pages
npm run build:server
npm run benchmark:large
```

The benchmark temporarily needs room for a generated 1.18 GB input plus its upload copy and working database. It cleans up its own temporary directory on normal completion or errors.

## Provider references

- [R2 pricing and free allowance](https://developers.cloudflare.com/r2/pricing/)
- [R2 activation](https://developers.cloudflare.com/r2/get-started/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 bucket CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Tunnel routing and large-file constraints](https://developers.cloudflare.com/tunnel/concepts/routing/)
- [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
