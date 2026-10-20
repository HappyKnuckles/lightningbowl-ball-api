// Upstream-shaped data (everything is a string, like bowwwl.com sends it).
import type { FetchFn } from '../../lib/upstream.js';

export type UpstreamBall = Record<string, string>;

export function upstreamBall(overrides: Record<string, string> = {}): UpstreamBall {
  return {
    availability: 'Available',
    ball_id: '1',
    ball_image: '/img/1.png',
    ball_name: 'Phaze II',
    brand_id: '10',
    brand_name: 'Storm',
    core_diff: '0.051',
    core_id: '100',
    core_image: '',
    core_int_diff: '0.000',
    core_name: 'Velocity',
    core_rg: '2.48',
    core_type: 'Symmetric',
    core_weight: '15',
    coverstock_id: '200',
    coverstock_name: 'TX-16',
    coverstock_type: 'Solid Reactive',
    factory_finish: '1500 Grit Polished',
    last_update: '2025-01-01',
    release_date: '2016-01-01',
    thumbnail_image: '',
    us_int: 'US',
    ...overrides,
  };
}

export const BALLS_15 = [
  upstreamBall({ ball_id: '1' }),
  upstreamBall({ ball_id: '2', ball_name: 'Phaze V', release_date: '2023-05-01', core_rg: '2.49', core_diff: '0.052' }),
  upstreamBall({
    ball_id: '3',
    ball_name: 'Black Widow 3.0',
    brand_name: 'Hammer',
    core_name: 'Gas Mask',
    core_type: 'Asymmetric',
    core_rg: '2.50',
    core_diff: '0.058',
    core_int_diff: '0.018',
    coverstock_name: 'Aggression',
    coverstock_type: 'Hybrid Reactive',
    release_date: '2022-03-01',
    us_int: 'Overseas',
    availability: 'Discontinued',
  }),
  upstreamBall({ ball_id: '4', ball_name: 'Jackal Ghost', brand_name: 'Motiv', core_rg: 'n/a', release_date: '2021-07-01' }),
];

export const BALLS_14 = [upstreamBall({ ball_id: '1', core_weight: '14', core_rg: '2.52' })];

export const BRANDS = [
  { brand_name: 'Storm', id: '10', logo: '' },
  { brand_name: 'Hammer', id: '11', logo: '' },
  { brand_name: 'Motiv', id: '12', logo: '' },
];

export const CORES = [
  { core_name: 'Velocity', brand: 'Storm', id: '100', api_filter_url: '' },
  { core_name: 'Gas Mask', brand: 'Hammer', id: '101', api_filter_url: '' },
];

export const COVERSTOCKS = [
  { coverstock_name: 'TX-16', brand: 'Storm', id: '200', api_filter_url: '' },
  { coverstock_name: 'Aggression', brand: 'Hammer', id: '201', api_filter_url: '' },
];

/**
 * Fake fetch serving the fixtures. `data` can be overridden per test; a value
 * that is an Error makes that URL fail.
 */
type Route = unknown[] | Error;

export function fakeUpstream(data: Record<string, Route> = {}): { fetchFn: FetchFn; calls: string[] } {
  const routes: Record<string, Route> = { brands: BRANDS, cores: CORES, coverstocks: COVERSTOCKS, 15: BALLS_15, 14: BALLS_14, ...data };
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    let body: Route;
    if (pathname.endsWith('/balls/v2')) {
      // `v2` is an array of pages (real paging) or one list returned for every
      // page (bowwwl ignoring `page`); absent means v2 has nothing.
      const v2 = routes.v2 ?? [];
      const page = Number(searchParams.get('page'));
      body = v2 instanceof Error ? v2 : Array.isArray(v2[0]) ? ((v2[page] as unknown[] | undefined) ?? []) : v2;
    } else {
      const key = searchParams.get('weight') ?? pathname.split('/').pop() ?? '';
      body = routes[key] ?? [];
    }
    if (body instanceof Error) throw body;
    const payload = body;
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchFn, calls };
}
