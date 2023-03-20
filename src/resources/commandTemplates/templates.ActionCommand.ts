import {
  Client,
  CommandInteraction,
  ContextMenuInteraction,
  DiscordAPIError,
  GuildMember,
  Interaction,
  Message,
  User,
} from 'discord.js';
import {
  SlashCommandBooleanOption,
  SlashCommandStringOption,
  SlashCommandUserOption,
} from '@discordjs/builders';
import type { APIApplicationCommandOptionChoice } from 'discord-api-types/v10';
import { ResponsiveSlashCommandSubcommandBuilder } from '@interactionHandling/commandBuilders.js';
import type InteractionHandler from '@interactionHandling/interactionHandler.js';
import COLLECTIONS from '@database/collections.js';
import EMBEDS from '../embeds.js';
import { getCustomisations, getRules, getSnowflakeMap } from '@utils.js';
import type ModerationLog from '@database/collections/subcollections/userLogs/collections.userLogs.moderationLogs.js';

function getBasicOptions(interaction: Interaction, options: Partial<OverrideActionOptions>) {
  const DELETE_MESSAGE = options['delete-message'] ?? (interaction.isCommand() ? interaction.options.getBoolean('delete-message', false) : undefined) ?? undefined;
  const ACTION = options['action'] ?? (interaction.isCommand() ? interaction.options.getString('action', true) : null);
  if (ACTION === null) throw new Error('ACTION must be defined either by using a CommandInteraction or an OverrideActionOptions with it set');
  const REASON = options['reason'] ?? (interaction.isCommand() ? interaction.options.getString('reason', true) : null);
  if (REASON === null) throw new Error('REASON must be defined either by using a CommandInteraction or an OverrideActionOptions with it set');
  const PRIVATE_NOTES = options['private-notes'] ?? (interaction.isCommand() ? interaction.options.getString('private-notes', false) : undefined);
  const RULE =
    (options['rule'] ?? JSON.parse((interaction.isCommand() ? interaction.options.getString('rule', false) : null) ?? 'null') as
      | string[]
      | null) ?? undefined;

  return {
    DELETE_MESSAGE,
    ACTION,
    REASON,
    PRIVATE_NOTES,
    RULE,
  };
}

async function getRuleDescriptions(rules: string[]): Promise<string[]> {
  const RULES = await getRules();

  const RESULT: string[] = [];

  for (const RULE of rules) {
    const RESOLVED_RULE = RULES[RULE] ?? {
      ruleNumber: 0,
      shortDesc: `Deleted rule; (${RULE})`,
    };
    RESULT.push(`${RESOLVED_RULE?.ruleNumber}. ${RESOLVED_RULE?.shortDesc ?? 'Unknown rule'}`);
  }

  return RESULT;
}

const durations = {
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  minute: 60 * 1000,
  second: 1000,
  millisecond: 1
}
function formatDuration (ms: number) {
  const parts = [];

  for (const [name, duration] of Object.entries(durations)) {
    const count = Math.trunc(ms / duration);
    if (count > 0) {
      parts.push(`${count} ${name}${count !== 1 ? 's' : ''}`);
      ms -= duration * count;
    }
  }

  return parts.join(', ');
}

async function formatLogMessage(
  client: Client,
  user: User,
  log: ModerationLog,
  extraActionOptions: ExtraActionOptions,
  _removePrivateInfo = false
): Promise<string> {
  let moderator: User | null = null;
  try {
    moderator = await client.users.fetch(log.moderator);
  } catch (e) {
    if (!(e instanceof DiscordAPIError)) throw e;
  }

  const reason =
    log.reason.length <= 300 ? log.reason : log.reason.slice(0, 300) + '...';

  return (
    `${extraActionOptions.emoji} ${moderator ?? 'Unknown'} *${
      extraActionOptions.pastTense
    }* ${log.userState.username}#${log.userState.discriminator} [\`${
      user.id
    }\`, <@${user.id}>]` + (
      log.action === 'timeout' ?
        ` *for ${log.timeoutDuration ? formatDuration(log.timeoutDuration) : 'an unknown amount of time'}*` : ''
    ) +
      `\n> ${reason}` +
      ` (Rules: ${(await getRuleDescriptions(log.rule ?? [])).join(', ')}` +
      (log.privateNotes ? `, Private notes: *${log.privateNotes}*)` : ')')
  );
}

async function sendToSrNotifyChannel(
  client: Client,
  message: string
): Promise<void> {
  const SNOWFLAKE_MAP = await getSnowflakeMap();
  const LOG_CHANNEL = await client.channels.fetch(SNOWFLAKE_MAP.Sr_Notify_Channel);

  if (
    !LOG_CHANNEL ||
    (LOG_CHANNEL.type !== 'GUILD_TEXT' &&
      LOG_CHANNEL.type !== 'GUILD_NEWS' &&
      LOG_CHANNEL.type !== 'GUILD_PUBLIC_THREAD' &&
      LOG_CHANNEL.type !== 'GUILD_PRIVATE_THREAD' &&
      LOG_CHANNEL.type !== 'GUILD_NEWS_THREAD' &&
      LOG_CHANNEL.type !== 'DM')
  ) return;

  try {
    await LOG_CHANNEL.send({
      content: message,
      allowedMentions: { parse: [], roles: SNOWFLAKE_MAP.Sr_Staff_Roles },
    });
  } catch {
    // If sending fails, it's far more important to ignore it and do the action anyway then worry and stop
  }
}

async function sendToLogChannel(
  client: Client,
  user: User,
  log: ModerationLog,
  extraActionOptions: ExtraActionOptions
): Promise<void> {
  const SNOWFLAKE_MAP = await getSnowflakeMap();

  const LOG_MESSAGE = await formatLogMessage(
    client,
    user,
    log,
    extraActionOptions
  );

  const RULES = await getRules();

  const LOG_CHANNEL_CATEGORIES = [log.action];
  for (const RULE of log.rule ?? []) {
    for (const CATEGORY of RULES[RULE]?.extraCategories ?? [])
      LOG_CHANNEL_CATEGORIES.push(CATEGORY);
  }

  const LOG_CHANNELS = LOG_CHANNEL_CATEGORIES.flatMap((CATEGORY) => {
    return (
      SNOWFLAKE_MAP.Mod_Logs_Channels[CATEGORY] ??
      SNOWFLAKE_MAP.Mod_Logs_Channels['default'] ??
      []
    );
  }).filter((item, index, array) => array.indexOf(item) === index);

  for (const MOD_LOG_CHANNEL of LOG_CHANNELS) {
    const LOG_CHANNEL = await client.channels.fetch(MOD_LOG_CHANNEL);

    if (
      !LOG_CHANNEL ||
      (LOG_CHANNEL.type !== 'GUILD_TEXT' &&
        LOG_CHANNEL.type !== 'GUILD_NEWS' &&
        LOG_CHANNEL.type !== 'GUILD_PUBLIC_THREAD' &&
        LOG_CHANNEL.type !== 'GUILD_PRIVATE_THREAD' &&
        LOG_CHANNEL.type !== 'GUILD_NEWS_THREAD' &&
        LOG_CHANNEL.type !== 'DM')
    )
      continue;

    try {
      await LOG_CHANNEL.send({
        content: LOG_MESSAGE,
        allowedMentions: { parse: [] },
      });
    } catch {
      // If sending fails, it's far more important to ignore it and do the action anyway then worry and stop
    }
  }
}

async function validateDuration(
  interaction: CommandInteraction | ContextMenuInteraction,
  options: Partial<OverrideActionOptions>,
): Promise<[boolean, number | undefined]> {
  // duration must be specific only if the action is a timeout
  const ACTION = options['action'] ?? (interaction.isCommand() ? interaction.options.getString('action', true) : null);
  if (ACTION === null) throw new Error('ACTION must be defined either by using a CommandInteraction or an OverrideActionOptions with it set');
  if (ACTION !== 'timeout' && ACTION !== 'ban') return [true, undefined];

  const INPUT = options['duration'] ?? (interaction.isCommand() ? interaction.options.getString('duration', false) : null);
  if (!INPUT)
    if (ACTION === 'ban')
      return [true, 0];
    else {
      await interaction.followUp({
        content: 'Timeout duration must be specified',
        ephemeral: true,
      });
      return [false, undefined];
    }

  if (!/^(?: *\d+(\.\d+)?[DHMS] *)+$/i.test(INPUT)) {
    await interaction.followUp({
      content:
        'Invalid duration format, example: `1h 30m 10s`\nMatch the regex: `/^(?: *\\d+[DHMS] *)+$/i`',
      ephemeral: true,
    });
    return [false, undefined];
  }

  let duration = 0;
  if (INPUT)
    for (const TIME of <RegExpMatchArray>INPUT.match(/\d+(\.\d+)?[DHMS]/gi)) {
      const TIME_GROUP = <{ [key in 'amount' | 'unit']: string }>(
        TIME.match(/(?<amount>\d+(\.\d+)?)(?<unit>[DHMS])/i)?.groups
      );
      switch (TIME_GROUP.unit.toUpperCase()) {
      case 'D':
        duration += Number(TIME_GROUP.amount) * 86400000;
        break;
      case 'H':
        duration += Number(TIME_GROUP.amount) * 3600000;
        break;
      case 'M':
        duration += Number(TIME_GROUP.amount) * 60000;
        break;
      case 'S':
        duration += Number(TIME_GROUP.amount) * 1000;
        break;
      }
    }

  if (
    ACTION === 'ban' &&
    ((duration /= 86400000) % 1 !== 0 || duration > 7 || duration < 0)
  ) {
    await interaction.followUp({
      content:
        'Ban duration must be between 1 and 7 days without hours, minutes, or seconds',
      ephemeral: true,
    });
    return [false, undefined];
  }

  return [true, duration];
}

async function sendNotice(
  USER: User,
  LOG: ModerationLog,
  interaction: CommandInteraction | ContextMenuInteraction,
) {
  try {
    await (
      await USER.createDM()
    ).send({
      embeds: [await EMBEDS.moderationNotice(LOG)],
    });
  } catch {
    return await interaction.followUp({
      content:
        'Could not send the notice to this user, they likely have their DMs disabled',
      ephemeral: true,
    });
  }
  return await interaction.followUp({
    content: 'Notice sent',
    ephemeral: true,
  });
}

export interface ExtraActionOptions {
  sendNoticeFirst?: boolean;
  emoji: string;
  pastTense: string;
}

export interface OverrideActionOptions {
  user: User;
  'message-id': string;
  'delete-message': boolean;
  'action': string;
  reason: string;
  rule: string[];
  duration: string;
  'private-notes': string;
}

export default class ActionCommand extends ResponsiveSlashCommandSubcommandBuilder {
  private readonly type: 'user' | 'message';

  static readonly actions: [
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember, reason: string) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (
        member: GuildMember,
        reason: string,
        duration?: number
      ) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember, reason: string) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember, reason: string, days?: number) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember, reason: string) => Promise<boolean>,
      ExtraActionOptions
    ],
    [
      APIApplicationCommandOptionChoice<string>,
      (member: GuildMember) => Promise<boolean>,
      (member: GuildMember, reason: string) => Promise<boolean>,
      ExtraActionOptions
    ],
  ] = [
      [
        {
          name: 'Verify',
          value: 'verify',
        },
        async (member) => {
          return member.manageable;
        },
        async (member, reason) => {
          if (!member.manageable) return false;
          const SNOWFLAKE_MAP = await getSnowflakeMap();
          return !!(await member.roles.add(SNOWFLAKE_MAP.Verified_Roles, reason));
        },
        { emoji: ':white_check_mark:', pastTense: 'verified' },
      ],
      [
        {
          name: 'Warn',
          value: 'warn',
        },
        async (member) => {
          return member.manageable;
        },
        async (member) => {
          if (!member.manageable) return false;
          return true;
        },
        { emoji: ':warning:', pastTense: 'warned' },
      ],
      [
        {
          name: 'Timeout',
          value: 'timeout',
        },
        async (member) => {
          return member.moderatable;
        },
        async (member, reason, duration) => {
          if (!member.moderatable) return false;
          return !!(await member.timeout(duration ?? null, reason));
        },
        { emoji: ':mute:', pastTense: 'timed out' },
      ],
      [
        {
          name: 'Kick',
          value: 'kick',
        },
        async (member) => {
          return member.kickable;
        },
        async (member, reason) => {
          if (!member.kickable) return false;
          return !!(await member.kick(reason));
        },
        { sendNoticeFirst: true, emoji: ':boot:', pastTense: 'kicked' },
      ],
      [
        {
          name: 'Ban',
          value: 'ban',
        },
        async (member) => {
          return member.bannable;
        },
        async (member, reason, days = 0) => {
          if (!member.bannable) return false;
          // FIXME: `days` option not working..?
          return !!(await member.ban({ reason, days }));
        },
        { sendNoticeFirst: true, emoji: ':hammer:', pastTense: 'banned' },
      ],
      [
        {
          name: 'Add Mature',
          value: 'add_mature',
        },
        async (member) => {
          return member.manageable;
        },
        async (member, reason) => {
          if (!member.manageable) return false;
          const SNOWFLAKE_MAP = await getSnowflakeMap();
          return !!(await member.roles.add(SNOWFLAKE_MAP.Mature_Roles, reason));
        },
        { emoji: ':white_check_mark:', pastTense: 'gave the mature role to' },
      ],
      [
        {
          name: 'Remove Mature',
          value: 'remove_mature',
        },
        async (member) => {
          return member.manageable;
        },
        async (member, reason) => {
          if (!member.manageable) return false;
          const SNOWFLAKE_MAP = await getSnowflakeMap();
          return !!(await member.roles.remove(SNOWFLAKE_MAP.Mature_Roles, reason));
        },
        { emoji: ':white_check_mark:', pastTense: 'removed the mature role from' },
      ],
    ];

  public constructor(type: 'user' | 'message') {
    super();
    this.type = type;
    (type === 'user'
      ? this.addUserParameters()
      : this.addMessageParameters()
    ).addBaseParameters();
  }

  override readonly response = async (
    interaction: Interaction,
    _interactionHandler: InteractionHandler,
    command: this,
    options?: Partial<OverrideActionOptions>
  ): Promise<void> => {
    if (!interaction.isCommand() && !interaction.isContextMenu())
      throw new Error('An invalid interaction type was passed into the ActionCommand response method');

    if (options === undefined) options = {};
    await interaction.deferReply({ ephemeral: true });

    const SNOWFLAKE_MAP = await getSnowflakeMap();

    // TODO: https://discord.com/channels/@me/960632564912115763/981297877131333642
    // get basic options
    const { DELETE_MESSAGE, ACTION, REASON, PRIVATE_NOTES, RULE } =
      getBasicOptions(interaction, options);

    const [IS_VALID_DURATION, DURATION] = await validateDuration(interaction, options);
    if (!IS_VALID_DURATION) return;

    let message: Message | undefined;
    if (command.type === 'message') {
      try {
        const messageId = options['message-id'] ?? (interaction.isCommand() ? interaction.options.getString('message-id', true) : null);
        if (messageId === null) throw new Error('For message ActionCommands, message-id must be defined either by using a CommandInteraction or an OverrideActionOptions with it set');
        message = await interaction.channel?.messages.fetch(
          messageId
        );
      } catch {
        // If the message isn't in the same channel we won't be able to fetch it
      }
      if (!message) {
        await interaction.followUp({
          content: 'Message not found',
          ephemeral: true,
        });
        return;
      }
    }

    const USER = message
      ? message.author
      : options['user'] ?? (interaction.isCommand() ? interaction.options.getUser('user', true) : null);
    if (USER === null) throw new Error('USER must be defined either by using a CommandInteraction, an OverrideActionOptions with it set or a message ActionCommand where it can be inferred from the message author');
    let member: GuildMember | undefined;
    try {
      member = await interaction.guild?.members.fetch(USER.id);
    } catch {
      // Sometimes we won't be able to fetch a member (i.e. if they aren't in the server).
    }

    const action = ActionCommand.actions.find(
      (action) => action[0].value === ACTION
    );

    if (!action) {
      console.log(`Action ${ACTION} not found, ignoring...`);
      return;
    }

    const CUSTOMISATIONS = await getCustomisations()

    // @ts-expect-error - If action is not valid, default will be used instead.
    const DAILY_ACTION_LIMITS = CUSTOMISATIONS.Daily_Action_Limits[ACTION] || CUSTOMISATIONS.Daily_Action_Limits['default']

    const activity = await COLLECTIONS.UserLog.checkModeratorActivityInTime(interaction.user.id, ACTION, durations.day);
    if (activity.length >= DAILY_ACTION_LIMITS) {
      await interaction.followUp({
        content:
          `Failed to perform action on a user: ${USER}. You have performed ${activity.length} ${ACTION} actions in the last 24 hours. (Limit: ${DAILY_ACTION_LIMITS})`,
        ephemeral: true,
      });

      await sendToSrNotifyChannel(interaction.client, `${SNOWFLAKE_MAP.Sr_Staff_Roles.map(u => `<@&${u}>`).join(', ')}\nModerator ${interaction.user} has exceeded their daily action limit of ${DAILY_ACTION_LIMITS} ${ACTION} actions in the last 24 hours.`)

      return;
    }

    // console.log(`Action Performed: ${ACTION} on ${USER.id}, not in cooldown (limit: ${DAILY_ACTION_LIMITS}) | Actions: ${activity.length}`);

    if (DELETE_MESSAGE && message?.deletable) message.delete();

    if (!member) {
      if (ACTION === 'ban') {
        try {
          const bannedUser = await interaction.guild?.members.ban(USER.id, {
            reason: REASON,
            days: DURATION ?? 0,
          });
          const LOG = await COLLECTIONS.UserLog.newModLog(
            interaction.user.id,
            USER,
            ACTION,
            REASON,
            RULE,
            PRIVATE_NOTES ?? undefined,
            DURATION,
            message
          );
          await sendToLogChannel(interaction.client, USER, LOG, action[3]);
          await interaction.followUp({
            content: `Banned out-of-server member ${
              typeof bannedUser === 'object'
                ? `${(bannedUser as User).tag} (${bannedUser.id})`
                : bannedUser
            }`,
          });
          return;
        } catch (e) {
          console.log(`Failed to ban a user: ${e}`);
          await interaction.followUp({
            content:
              'I couldn\'t ban that user, check that you provided the right ID',
            ephemeral: true,
          });
          return;
        }
      }
      await interaction.followUp({
        content: 'User not found in this server',
        ephemeral: true,
      });
      return;
    }

    if (member.roles.cache.hasAny(...SNOWFLAKE_MAP.Staff_Roles)) {
      await interaction.followUp({
        content: 'You cannot take action on staff members',
        ephemeral: true,
      });
      return;
    }

    const LOG = await COLLECTIONS.UserLog.newModLog(
      interaction.user.id,
      USER,
      ACTION,
      REASON,
      RULE,
      PRIVATE_NOTES ?? undefined,
      DURATION,
      message
    );

    if (!(await action[1](member))) {
      await interaction.followUp({
        content:
          'You cannot take action on members with higher permission than this bot',
        ephemeral: true,
      });
      return;
    }

    await sendToLogChannel(interaction.client, USER, LOG, action[3]);
    if (action[3].sendNoticeFirst) await sendNotice(USER, LOG, interaction);

    if (!(await action[2](member, REASON, DURATION))) {
      await interaction.followUp({
        content:
          'Something went wrong while trying to punish the user, please make sure you have permission',
        ephemeral: true,
      });
      return;
    }

    if (!action[3].sendNoticeFirst) await sendNotice(USER, LOG, interaction);

  };

  private addUserParameters() {
    return this.addUserOption(
      new SlashCommandUserOption()
        .setName('user')
        .setDescription('The user to take action on')
        .setRequired(true)
    );
  }

  private addMessageParameters() {
    return this.addBooleanOption(
      new SlashCommandBooleanOption()
        .setName('delete-message')
        .setDescription('Whether to delete the specified message')
        .setRequired(true)
    ).addStringOption(
      new SlashCommandStringOption()
        .setName('message-id')
        .setDescription('The message to take action on')
        .setRequired(true)
    );
  }

  private async addBaseParameters() {
    return this.addStringOption(
      new SlashCommandStringOption()
        .setName('action')
        .setDescription('The action to take')
        .addChoices(...ActionCommand.actions.map((action) => action[0]))
        .setRequired(true)
    )
      .addStringOption(
        new SlashCommandStringOption()
          .setName('reason')
          .setDescription('The reason for the action')
          .setRequired(true)
      )
      .addStringOption(
        new SlashCommandStringOption()
          .setName('rule')
          .setDescription('The rule to apply')
          .addChoices(
            ...(await (async () => {
              const RULES: APIApplicationCommandOptionChoice<string>[] = [];
              Object.entries(await getRules())
                .sort(
                  ([_aID, aRule], [_bID, bRule]) =>
                    aRule.ruleNumber - bRule.ruleNumber
                )
                .forEach(([key, rule]) => {
                  if (!rule.active) return;
                  RULES.push({
                    name: `${rule.ruleNumber}. ${rule.shortDesc}`,
                    value: JSON.stringify([key]),
                  });

                  // FIXME: extended rules exceed 25 choices limit
                  //rule.extended?.forEach((extended, j) => {
                  //  if (!extended.active) return;
                  //  RULES.push({name: `${rule.index}.${extended.index}. ${extended.shortDesc}`, value: `${i}.${j}`});
                  //});
                });

              return RULES;
            })())
          )
          .setRequired(true)
      )
      .addStringOption(
        new SlashCommandStringOption()
          .setName('duration')
          .setDescription('Duration of the timeout, if the action is a timeout')
          .setRequired(false)
      )
      .addStringOption(
        new SlashCommandStringOption()
          .setName('private-notes')
          .setDescription('Private notes to add')
          .setRequired(false)
      );
  }
}
