import type { NormalizedPost } from '../types/reddit';
import type { ListingSort, TopTimeRange } from './redditApi';

const LISTING_SORTS = ['hot', 'new', 'rising', 'top'] as const;
const TOP_TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'] as const;
const MEDIA_POST_TYPES: Array<NormalizedPost['media']['type']> = ['image', 'gallery', 'video', 'external'];

export function getValidatedListingSort(input: string | null): ListingSort {
  return LISTING_SORTS.includes(input as ListingSort) ? (input as ListingSort) : 'hot';
}

export function getValidatedTopTimeRange(input: string | null): TopTimeRange {
  return TOP_TIME_RANGES.includes(input as TopTimeRange) ? (input as TopTimeRange) : 'day';
}

export function isMediaPost(mediaType: NormalizedPost['media']['type']): boolean {
  return MEDIA_POST_TYPES.includes(mediaType);
}
