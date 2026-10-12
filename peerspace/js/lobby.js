/**
 * lobby.js — Room creation and joining logic for index.html
 */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const nameInput  = document.getElementById('nameInput');
  const roomInput  = document.getElementById('roomInput');
  const createBtn  = document.getElementById('createBtn');
  const joinBtn    = document.getElementById('joinBtn');
  const genBtn     = document.getElementById('genRoomBtn');
  const errMsg     = document.getElementById('errMsg');

  // Room code from an invite link (?r=CODE) wins; otherwise generate a fresh one.
  // We only trim/uppercase/limit length (matching the input's maxlength) — we do
  // not strip characters, so custom codes like "MY-TEAM" survive the round trip.
  const invited = (new URLSearchParams(location.search).get('r') || '')
    .trim().toUpperCase().slice(0, 8);
  if (invited) {
    roomInput.value = invited;
    nameInput.focus();           // the only thing an invitee still needs to enter
  } else {
    roomInput.value = generateRoomId();
  }

  genBtn.addEventListener('click', () => {
    roomInput.value = generateRoomId();
    roomInput.focus();
  });

  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const room = roomInput.value.trim().toUpperCase();
    if (!name) { showErr('Enter your name first.'); return; }
    if (!room)  { showErr('Enter a room code.'); return; }
    openRoom(room, name);
  });

  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const room = roomInput.value.trim().toUpperCase();
    if (!name) { showErr('Enter your name first.'); return; }
    if (!room)  { showErr('Enter the room code shared with you.'); return; }
    openRoom(room, name);
  });

  // Also open on Enter in room input
  roomInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinBtn.click();
  });
  // ...and in the name field, so an invitee can type a name and press Enter.
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinBtn.click();
  });

  function openRoom(roomId, name) {
    const url = `room.html?r=${encodeURIComponent(roomId)}&n=${encodeURIComponent(name)}`;
    window.open(url, '_blank');
  }

  function showErr(msg) {
    errMsg.textContent = msg;
    errMsg.hidden = false;
    setTimeout(() => errMsg.hidden = true, 3000);
  }
});
