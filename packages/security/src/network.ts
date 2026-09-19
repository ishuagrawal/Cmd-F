import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { actionPolicy, shareableUrl } from './index';
export interface NetworkPolicy {
  validate(url: URL, origin: string): Promise<{ address: string; family: 4 | 6 }>;
}
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export const publicNetworkPolicy: NetworkPolicy = {
  async validate(u, origin) {
    if (
      u.protocol !== 'https:' ||
      u.origin !== origin ||
      (u.port && u.port !== '443') ||
      !shareableUrl(u.href) ||
      actionPolicy(u.href) !== 'read_candidate'
    )
      throw new Error('policy_blocked');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const ips = ipaddr.isValid(host)
      ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
      : await dns.lookup(host, { all: true });
    if (!ips.length || ips.some((x) => !publicAddress(x.address)))
      throw new Error('private_network');
    return { address: ips[0].address, family: ips[0].family as 4 | 6 };
  },
};
