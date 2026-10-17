# Shap test stack

Runs Shap on your PC and makes it reachable from your phone through a Cloudflare tunnel. It's set
up like Steady's and Sorted's test stacks and runs alongside them: separate containers, network,
data and ports (Steady uses 8090+, Sorted 8180+, Shap 8280+).

This is for testing. It has no backups and keeps the data on your PC.

## Needs

Docker with Compose v2, plus `curl`, `openssl` and `python3`. `qrencode` is optional, and prints a
QR code to scan with your phone.

## 1. A fixed address (recommended)

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** →
   **Cloudflared**. Name it `shap-test` (a separate tunnel from Steady's and Sorted's).
2. Copy the **token** (the long string after `--token`).
3. **Public hostname**: subdomain `shap-test`, your domain, service type **HTTP**, URL `app:8080`.
4. Run `./start.sh` once (it creates `.env`), then edit `deploy/test/.env`:
   ```
   TUNNEL_TOKEN=<the token>
   PUBLIC_URL=https://shap-test.<your domain>
   ```

Skip this and `start.sh` uses a quick tunnel: a random `trycloudflare.com` address that changes
each start.

## 2. Start

```bash
cd deploy/test
./start.sh                         # start with the fictional demo company and print the address
./start.sh --import tracker.xlsx   # start fresh with your own tracker (asks for your login)
./start.sh --update                # pull the latest code from GitHub and rebuild
./start.sh --stop                  # stop (data is kept)
./start.sh --reset                 # delete all test data; the demo company is reloaded next start
```

`--import` deletes the demo company, creates your owner login, imports the tracker and prints the
checks against Per Project and the Trade Statement. It remembers that this stack holds your data,
so later starts don't load the demo again (until `--reset`).

## 3. On your phone

1. Open the printed address and sign in.
2. Android: Chrome's menu → **Add to Home screen**. iPhone: Safari → **Share** →
   **Add to Home Screen**.
3. Shap now opens full screen with the shaka icon. The orange **Log** button in the middle of the
   bottom bar is the site screen.

## Things to try with the demo

- **Log a crew day** on your phone: Log → pick the job → tap Sipho and Thabo → *Log 2 workers*.
  The job's spent figure and both workers' "owed" go up.
- **Sort later**: log a day with *Sort later*, then Workers → **Allocate** puts it on a job.
- **Cost with a slip**: Log → Cost → *Photo of the slip*.
- **Quote to paid**: the Naidoo Pergola job has a parts plan and a draft quote. Open the quote →
  *Turn into an invoice* → *Issue invoice* → *Record a payment* → *Share PDF*.
- **The books**: Accounts → Income statement → *By month*, then the balance sheet, then a
  balance check.
- **Site login**: sign in as `site@example.co.za` on the phone. It can log days and costs but sees
  no money.
