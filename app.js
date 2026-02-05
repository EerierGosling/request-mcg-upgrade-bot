require("dotenv").config();
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const APPROVAL_CHANNEL = process.env.APPROVAL_CHANNEL_ID;

app.command("/request-mcg-upgrade", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "mcg_upgrade_request",
      title: { type: "plain_text", text: "Request MCG Upgrade" },
      submit: { type: "plain_text", text: "Submit" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: JSON.stringify({ requester_id: body.user_id }),
      blocks: [
        {
          type: "input",
          block_id: "user_block",
          label: { type: "plain_text", text: "user to upgrade" },
          element: {
            type: "users_select",
            action_id: "user_select",
            placeholder: { type: "plain_text", text: "select a user" },
          },
        },
        {
          type: "input",
          block_id: "reason_block",
          label: { type: "plain_text", text: "reason for upgrade" },
          element: {
            type: "plain_text_input",
            action_id: "reason_input",
            multiline: true,
            placeholder: { type: "plain_text", text: "why does this user need to be upgraded? if they requested it somewhere, link their message." },
          },
        },
      ],
    },
  });
});

app.view("mcg_upgrade_request", async ({ ack, body, view, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  const requesterId = metadata.requester_id;
  const targetUserId = view.state.values.user_block.user_select.selected_user;
  const reason = view.state.values.reason_block.reason_input.value;

  const userInfo = await client.users.info({ user: targetUserId });
  if (!userInfo.user.is_restricted && !userInfo.user.is_ultra_restricted) {
    await ack({
      response_action: "errors",
      errors: {
        user_block: "that user is already a full member of slack!",
      },
    });
    return;
  }

  await ack();

  await client.chat.postMessage({
    channel: APPROVAL_CHANNEL,
    text: `upgrade request for <@${targetUserId}>`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*upgrade request*\n\n*requested by:* <@${requesterId}>\n*user to upgrade:* <@${targetUserId}>\n*reason:* ${reason}`,
        },
      },
      {
        type: "actions",
        block_id: "approval_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "approve_upgrade",
            value: JSON.stringify({ target_user: targetUserId, requester: requesterId }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            action_id: "deny_upgrade",
            value: JSON.stringify({ target_user: targetUserId, requester: requesterId }),
          },
        ],
      },
    ],
  });
});

app.action("approve_upgrade", async ({ ack, body, client, action }) => {
  await ack();

  const data = JSON.parse(action.value);
  const approverId = body.user.id;

  try {
    await performUpgrade(data.target_user);
  } catch (error) {
    if (error.message === "user is already a full member") {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `upgrade request for <@${data.target_user}> - failed`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*upgrade request* ❌ *failed*\n\n*requested by:* <@${data.requester}>\n*user:* <@${data.target_user}>\n*reason:* ${reason}\n*approved by:* <@${approverId}>\n\n_user is already a full member of slack_`,
            },
          },
        ],
      });
      return;
    }
    await client.chat.postMessage({
      channel: body.channel.id,
      text: `failed to upgrade <@${data.target_user}>: ${error.message}`,
    });
    return;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `upgrade request for <@${data.target_user}> - approved!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*upgrade request* ✅ *approved*\n\n*requested by:* <@${data.requester}>\n*user upgraded:* <@${data.target_user}>\n*reason:* ${reason}\n*approved by:* <@${approverId}>`,
        },
      },
    ],
  });

  await client.chat.postMessage({
    channel: data.requester,
    text: `your upgrade request for <@${data.target_user}> has been approved by <@${approverId}>!`,
  });

  await client.chat.postMessage({
    channel: data.target_user,
    text: `you've been upgraded to a full user of slack by <@${approverId}>!`,
  });
});

app.action("deny_upgrade", async ({ ack, body, client, action }) => {
  await ack();

  const data = JSON.parse(action.value);
  const denierId = body.user.id;

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `upgrade request for <@${data.target_user}> - denied`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*upgrade request* ❌ *denied*\n\n*requested by:* <@${data.requester}>\n*user:* <@${data.target_user}>\n*reason:* ${reason}\n*denied by:* <@${denierId}>`,
        },
      },
    ],
  });
});

async function performUpgrade(userId) {

  const userInfo = await client.users.info({ user: userId });
  if (!userInfo.user.is_restricted && !userInfo.user.is_ultra_restricted) {
    throw new Error("user is already a full member");
  }
  const formData = new FormData();
  formData.append("token", process.env.SLACK_XOXC_TOKEN);
  formData.append("user", userId);
  formData.append("_x_reason", "adminMembersStore_makeRegular");
  formData.append("_x_mode", "online");

  const response = await fetch("https://hackclub.slack.com/api/users.admin.setRegular", {
    method: "POST",
    headers: {
      cookie: `d=${process.env.SLACK_D_COOKIE}`,
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || "failed to upgrade user");
  }
}

(async () => {
  await app.start();
  console.log("running!");
})();
