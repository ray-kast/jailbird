import { Option, Command, Argument } from 'commander';
import { Client } from 'twitter-api-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';

const checkErr = <T>(
  {
    data,
    errors,
  }: {
    data?: T | undefined;
    errors?: any[] | undefined;
  },
  handler:
    | { fatal: boolean; handler?: undefined }
    | { fatal: false; handler: (e: any) => void },
): T => {
  if (errors) {
    errors.forEach((e) => console.error(e));

    if (handler.fatal) {
      throw 'API returned an error';
    } else if (handler.handler) {
      errors.forEach(handler.handler);
    }
  }

  if (data === undefined) {
    throw 'API returned no data';
  }

  return data;
};

const resolveCdn = async (url: string): Promise<string> => {
  while (/\/t\.co\//.test(url)) {
    let req: http.ClientRequest | undefined;
    const realUrl = await new Promise<string | undefined>((ok, err) => {
      req = (/https:/.test(url) ? https : http)
        .get(url, (res) => {
          if (
            res.statusCode !== undefined &&
            res.statusCode >= 300 &&
            res.statusCode < 400
          ) {
            ok(res.headers.location);
          }

          res.on('data', (d) => void d);

          ok(undefined);
        })
        .on('error', (e) => err(e));
    });

    if (req && !req.destroyed) {
      req.destroy();
    }

    if (!realUrl || !/:/.test(realUrl)) {
      console.warn(
        `realUrl \`${realUrl}' for \`${url}' doesn't look like a URL!`,
      );
      break;
    }

    url = realUrl;
  }

  return url;
};

// Parse differences from the URL spec to satisfy the Twitter gods:
// - /[\-]/ not allowed in URL scheme
// - /[.:!()]/ not allowed in path end
const urlRegex =
  /(?:[a-zA-Z][a-zA-Z0-9+\.]*:)\/\/(?:[^$\/\?#]+)(?:\/[a-zA-Z0-9\$&'()*+,\-.\/:;=\?@_~#]*(?<![.:!()]))?/g;

const populateMap = async (
  map: Map<string, Map<string, true>>,
  { token, user }: { token: string; user: string },
): Promise<void> => {
  const getInner = (user: string): Map<string, true> => {
    let inner = map.get(user);
    if (!inner) {
      map.set(user, (inner = new Map()));
    }

    return inner;
  };

  const client = new Client(token);
  const usr = checkErr(await client.users.findUserByUsername(user), {
    fatal: true,
  });

  const following = client.users.usersIdFollowing(usr.id, {
    'user.fields': [
      'description',
      'entities',
      'id',
      'location',
      'name',
      'pinned_tweet_id',
      'protected',
      'url',
      'username',
    ],
  });

  const pinnedTweetOwners = new Map();
  let i = 0;

  for await (const resp of following) {
    const page = checkErr(resp, { fatal: true });

    console.info(`Page ${i + 1}...`);

    // console.info({ page });

    for (const {
      description,
      entities,
      id,
      location,
      name,
      pinned_tweet_id,
      protected: isProtected,
      url,
      username,
      ...rest
    } of page) {
      if (Object.keys(rest).length > 0) {
        console.warn(`Found extra data for @${username}:`, rest);
      }

      const inner = getInner(username);

      if (!!url && /:/.test(url)) {
        console.info(`Pulling URL for @${username}...`);

        const realUrl = await resolveCdn(url);
        inner.set(realUrl, true);
      }

      for (const match of (description ?? '').matchAll(urlRegex)) {
        console.info(`Pulling bio URL for @${username}...`);

        const realUrl = await resolveCdn(match[0] ?? '');
        inner.set(realUrl, true);
      }

      if (!!pinned_tweet_id) {
        pinnedTweetOwners.set(pinned_tweet_id, username);
      }
    }

    i += 1;
  }

  const ids = Array.from(pinnedTweetOwners.keys());
  for (let i = 0; i < ids.length; i += 100) {
    const tweets = checkErr(
      await client.tweets.findTweetsById({
        ids: ids.slice(i, i + 100),
      }),
      {
        fatal: false,
        handler: (e) => {
          const owner =
            pinnedTweetOwners.get(e.resource_id) ??
            pinnedTweetOwners.get(e.value);

          if (!owner) {
            throw e;
          }

          getInner(owner).set(
            `https://twitter.com/${owner}/status/${
              e.resource_id ?? e.value
            }#pin-err`,
            true,
          );
        },
      },
    );

    for (const tweet of tweets) {
      const owner = pinnedTweetOwners.get(tweet.id);
      const inner = getInner(owner);

      for (const match of (tweet.text ?? '').matchAll(urlRegex)) {
        console.info(`Pulling pinned URL for @${owner}...`);

        const realUrl = await resolveCdn(match[0] ?? '');

        const statusRegex = /twitter\.com\/([^\/]+)\/status\/(\d+)/;
        const statusMatch = realUrl.match(statusRegex);

        if (
          statusMatch &&
          statusMatch[1] == owner &&
          statusMatch[2] == tweet.id
        ) {
          continue;
        }

        inner.set(realUrl, true);
      }
    }
  }
};

const main = async (): Promise<void> => {
  dotenv.config();

  const pgm = new Command('jailbird');

  pgm
    .addOption(
      new Option('-t, --token <token>', 'Twitter API token')
        .env('TWITTER_API_TOKEN')
        .makeOptionMandatory(true),
    )
    .addOption(
      new Option(
        '-o, --output <output>',
        'Filename to write to',
      ).makeOptionMandatory(true),
    )
    .addArgument(new Argument('<user>', 'User to pull data for'))
    .parse();

  let [user] = pgm.args;
  const { token, output } = pgm.opts();

  if (!user) {
    console.error('Invalid username!');
    return;
  }

  const stat = await fs.stat(output).catch((e): undefined => {
    console.warn(e);
    return undefined;
  });

  if (stat && stat.size) {
    console.warn(`File '${output}' already exists!`);

    const rl = readline.createInterface({ input: stdin, output: stdout });

    if (!/y/i.test(await rl.question('Continue anyway? [y/N] '))) {
      rl.close();
      return undefined;
    }

    rl.close();
  }

  console.info(user);
  user = user.replace(/^@?/, '');
  console.info(`Pulling follow list for @${user}...`);

  const map = new Map<string, Map<string, true>>();

  try {
    await populateMap(map, { token, user });

    console.info('Done!');
  } catch (e) {
    console.error('An error occured while populating the user map!');
    console.error(e);
  }

  console.info('Writing to file...');
  const file = await fs.open(output, 'w', 0o644);

  for (const user of map.keys()) {
    const inner = map.get(user);
    await file.write(Buffer.from(`https://twitter.com/${user}:\n`, 'utf-8'));

    if (!inner) {
      continue;
    }

    for (const url of inner.keys()) {
      await file.write(Buffer.from(`- ${url}\n`, 'utf-8'));
    }
  }

  await file.sync();
  await file.close();

  console.info('File saved.');
};

main();
