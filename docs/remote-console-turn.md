# Remote Console relay (TURN)

Remote Console tries a direct connection between the browser and the device first. When the networks in between block that, it needs a TURN relay to carry the video. Without one, sessions between different networks often fail with `ICE failed`.

Choose one of these with `TURN_PROVIDER` in the backend's environment:

| `TURN_PROVIDER` | Relay | Good for | You provide |
|---|---|---|---|
| `builtin` | Your own coturn server | Keeping everything on your infrastructure | A server with a public IP and open ports |
| `cloudflare` | Cloudflare Realtime TURN | No server or router changes | A Cloudflare account, and payment per GB relayed |
| `none` | No relay | Devices and technicians on the same network | Nothing |

If `TURN_PROVIDER` is not set, the backend uses Cloudflare when its two settings are present, then the built-in relay when its two settings are present, and otherwise no relay.

The backend gives each session its own short-lived credentials, so the long-term secrets below never reach browsers or agents. If the relay is unavailable, sessions continue with STUN only and the backend logs a warning.

## Built-in relay (coturn)

The relay needs a public IP address. These ports must be reachable from the internet, forwarded from your router if it is behind NAT:

- `3478` TCP and UDP
- `49160-49200` UDP, one port per relayed connection, so widen the range for more concurrent sessions

Set up the relay:

```bash
cd deploy/turn
cp .env.example .env
openssl rand -hex 32     # put this in .env as TURN_AUTH_SECRET
nano .env                # also set TURN_REALM and TURN_EXTERNAL_IP
docker compose up -d
```

Add these to the backend's environment, then restart it:

```bash
TURN_PROVIDER=builtin
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_AUTH_SECRET=the-same-secret-as-the-relay
```

The included configuration refuses to relay traffic to private network addresses. That stops someone with credentials from using the relay to reach your internal network. Keep those rules unless you have a specific reason to remove them.

## Cloudflare

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/calls), create a TURN key under Realtime.
2. Add these to the backend's environment, then restart it:

```bash
TURN_PROVIDER=cloudflare
CLOUDFLARE_TURN_KEY_ID=your-turn-token-id
CLOUDFLARE_TURN_API_TOKEN=your-api-token
```

Cloudflare charges per GB relayed. Check [its pricing](https://developers.cloudflare.com/realtime/turn/) before relying on it. Sessions that connect directly do not use the relay.

## STUN servers

STUN helps devices find a direct route and carries no session data. By default, the backend uses public servers from Cloudflare and Google. With the built-in relay or no relay, you can use your own with `TURN_STUN_URLS`, a comma-separated list such as `stun:turn.example.com:3478`.

## Checking that it works

Start Remote Console from a different network than the device. In Chrome, `chrome://webrtc-internals` shows `relay` candidates when the relay is working. If sessions still fail, look in the backend log for a warning containing `TURN`.
