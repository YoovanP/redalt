import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchSubredditSuggestions } from '../lib/redditApi';

type SubredditSwitcherProps = {
  initialSubreddit: string;
};

function isRedditHost(hostname: string): boolean {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com');
}

function parseRedditTarget(input: string): string | null {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  const maybeUrl = /^(?:https?:\/\/)?(?:www\.|old\.|m\.)?reddit\.com\//i.test(trimmed);
  const maybePath = trimmed.startsWith('/');

  let path = '';
  let search = '';

  if (maybeUrl) {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const url = new URL(withProtocol);

      if (!isRedditHost(url.hostname.toLowerCase())) {
        return null;
      }

      path = url.pathname;
      search = url.search;
    } catch {
      return null;
    }
  } else if (maybePath) {
    path = trimmed;
  } else {
    return null;
  }

  const parts = path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const section = parts[0].toLowerCase();

  if (section === 'r') {
    const subreddit = parts[1];

    if (!subreddit) {
      return null;
    }

    if (parts[2]?.toLowerCase() === 'comments' && parts[3]) {
      return `/r/${subreddit}/comments/${parts[3]}`;
    }

    return `/r/${subreddit}${search}`;
  }

  if ((section === 'u' || section === 'user') && parts[1]) {
    return `/u/${parts[1]}`;
  }

  return null;
}

function sanitizeSubreddit(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')[0]
    ?.replace(/[^A-Za-z0-9_]/g, '');
  return cleaned || 'mildlyinfuriating';
}

export function SubredditSwitcher({ initialSubreddit }: SubredditSwitcherProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState(initialSubreddit);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const normalizedValue = useMemo(
    () => {
      if (parseRedditTarget(value)) {
        return '';
      }

      return value.trim().replace(/^\/?r\//i, '').toLowerCase();
    },
    [value],
  );

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      const nextSuggestions = await fetchSubredditSuggestions(value);
      setSuggestions(nextSuggestions);

      const canShow = isFocused && normalizedValue.length >= 2 && nextSuggestions.length > 0;
      setShowSuggestions(canShow);
    }, 220);

    return () => {
      window.clearTimeout(handle);
    };
  }, [value, normalizedValue, isFocused]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const directTarget = parseRedditTarget(value);

    if (directTarget) {
      setShowSuggestions(false);
      navigate(directTarget);
      return;
    }

    const subreddit = sanitizeSubreddit(value);
    setValue(subreddit);
    setShowSuggestions(false);
    navigate(`/r/${subreddit}${location.search}`);
  };

  const onPickSuggestion = (subreddit: string) => {
    setValue(subreddit);
    setShowSuggestions(false);
    navigate(`/r/${subreddit}${location.search}`);
  };

  return (
    <form className="subreddit-form" onSubmit={onSubmit}>
      <div className="subreddit-input-wrap">
        <input
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);

            const normalizedNextValue = nextValue.trim().replace(/^\/?r\//i, '').toLowerCase();
            setShowSuggestions(isFocused && suggestions.length > 0 && normalizedNextValue.length >= 2);
          }}
          onFocus={() => {
            setIsFocused(true);
            setShowSuggestions(suggestions.length > 0 && normalizedValue.length >= 2);
          }}
          onBlur={() =>
            window.setTimeout(() => {
              setIsFocused(false);
              setShowSuggestions(false);
            }, 120)
          }
          placeholder="mildlyinfuriating"
          aria-label="Subreddit"
          aria-autocomplete="list"
          autoComplete="off"
        />

        {showSuggestions && (
          <ul className="subreddit-suggestions" role="listbox" aria-label="Subreddit suggestions">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" onMouseDown={() => onPickSuggestion(suggestion)}>
                  r/{suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="submit">Go</button>
    </form>
  );
}
