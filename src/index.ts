import { Option, Command, Argument } from 'commander';
import { Client } from 'twitter-api-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';

const checkErr = <T>({
  data,
  errors,
}: {
  data?: T;
  errors?: any[] | undefined;
}): T => {
  if (errors) {
    errors.forEach((e) => console.error(e));
    throw 'API returned an error';
  }

  return data;
};

const main = async () => {
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

  console.info(user);
  user = user.replace(/^@?/, '');
  console.info(`Pulling follow list for @${user}...`);

  const client = new Client(token);
  const usr = checkErr(await client.users.findUserByUsername(user));
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

  // const pinnedTweetIds = new Map();

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

  try {
    const stat = await fs.stat(output);

    if (stat.size) {
      console.warn('File already exists!');
    }
  } catch (e) {
    console.warn(e);
  }

  const file = await fs.open(output, 'w', 0o644);

  let i = 0;
  for await (const resp of following) {
    const page = checkErr(resp);

    console.info(`Page ${i + 1}...`);

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

      await file.write(
        Buffer.from(`https://twitter.com/${username}:\n`, 'utf-8'),
      );

      if (!!url && /:/.test(url)) {
        console.info(`Pulling URL for @${username}...`);
        let req;
        const realUrl = await new Promise<string | undefined>((ok, err) => {
          req = (/https:/.test(url) ? https : http)
            .get(url, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400) {
                ok(res.headers.location);
              }

              res.on('data', (d) => void d);

              ok(undefined);
            })
            .on('error', (e) => err(e));
        });

        if (!realUrl || !/:/.test(realUrl)) {
          console.warn(`realUrl \`${realUrl}' doesn't look like a URL!`);
        }

        await file.write(Buffer.from(`- ${realUrl ?? url}\n`, 'utf-8'));
      }

      // if (!!pinned_tweet_id) {
      //   pinnedTweetIds.set(id, pinned_tweet_id);
      // }
    }

    await file.sync();

    i += 1;
  }

  console.info('Done!');

  // const ids = Array.from(pinnedTweetIds.values());

  // for (let i = 0; i < ids.length; i += 100) {
  //   const tweets = await client.tweets.findTweetsById({
  //     ids: ids.slice(i, i + 100),
  //   });
  //   console.info(tweets);
  // }
};

main();
