import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Destinations a caller must never be able to point us at: loopback, private,
 * link-local (169.254.169.254 is the cloud metadata endpoint), CGNAT, multicast
 * and reserved space. `node:net`'s BlockList does the subnet arithmetic — and
 * critically, `check(addr, 'ipv6')` matches IPv4-mapped forms like
 * `::ffff:169.254.169.254` against the IPv4 rules.
 */
const BLOCKED_HOSTS = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED_HOSTS.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  BLOCKED_HOSTS.addSubnet(net, bits, 'ipv6');
}

/**
 * Whether every address `host` resolves to is public.
 *
 * Resolving first is what closes the integer/hex/shorthand IPv4 bypasses
 * (`https://2130706433/`, `https://0x7f000001/`, `https://127.1/`): getaddrinfo
 * normalises all of them to 127.0.0.1, which BlockList then catches. A literal
 * IP skips DNS. Any single private answer rejects the whole host — fail closed.
 *
 * ponytail: DNS rebinding is the residual hole. undici re-resolves when it
 * connects, so a TTL-0 record can answer public here and private there. Closing
 * it needs a pinned-IP connect (custom undici Agent with `connect.lookup`, or a
 * dispatcher bound to the vetted address); the whole class also goes away if
 * references are moved behind an egress proxy.
 */
export async function isPublicHost(hostname: string): Promise<boolean> {
  // URL keeps IPv6 literals bracketed; isIP does not accept the brackets.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  const literal = isIP(host);
  let addrs: { address: string; family: number }[];
  if (literal) {
    addrs = [{ address: host, family: literal }];
  } else {
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      return false;
    }
  }
  if (!addrs.length) return false;
  return !addrs.some((a) => BLOCKED_HOSTS.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
}
