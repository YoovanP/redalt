import type { ListingSort, TopTimeRange } from '../lib/redditApi';

type SortControlsProps = {
  sort: ListingSort;
  topTimeRange: TopTimeRange;
  onSortChange: (nextSort: ListingSort) => void;
  onTopTimeRangeChange: (nextRange: TopTimeRange) => void;
};

export function SortControls({
  sort,
  topTimeRange,
  onSortChange,
  onTopTimeRangeChange,
}: SortControlsProps) {
  return (
    <div className="sort-controls" role="group" aria-label="Sort posts">
      <label>
        Sort
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value as ListingSort)}
        >
          <option value="hot">hot</option>
          <option value="rising">rising</option>
          <option value="new">new</option>
          <option value="top">top</option>
        </select>
      </label>

      {sort === 'top' && (
        <label>
          Top range
          <select
            value={topTimeRange}
            onChange={(event) => onTopTimeRangeChange(event.target.value as TopTimeRange)}
          >
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </label>
      )}
    </div>
  );
}
