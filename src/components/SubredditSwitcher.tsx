import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

type SubredditSwitcherProps = {
  initialSubreddit: string;
};

function sanitizeSubreddit(input: string): string {
  const cleaned = input.trim().replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
  return cleaned || 'mildlyinfuriating';
}

export function SubredditSwitcher({ initialSubreddit }: SubredditSwitcherProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState(initialSubreddit);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subreddit = sanitizeSubreddit(value);
    setValue(subreddit);
    navigate(`/r/${subreddit}${location.search}`);
  };

  return (
    <form className="subreddit-form" onSubmit={onSubmit}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="mildlyinfuriating"
        aria-label="Subreddit"
      />
      <button type="submit">Go</button>
    </form>
  );
}
