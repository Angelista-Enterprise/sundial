// The words on a button, per language (owner decision 2026-11-17: a Dutch "Verzenden" is a Send). One table: a language is one
// entry here, and every reader below (finalWord, plainWord, composerWord, talkOf, runsReturn) reads all of them at once.
//
// Per language:
//   finals   the words a final control's name starts with, per kind (regex sources; a space matches any run of spaces)
//   not      per kind, the words right after (or, for a verb-last name, anywhere before) a final's word that make it no final:
//            "Leave a comment" opens a box, "Accept all cookies" answers a banner
//   last     the verb may come last ("Bericht verwijderen", "Nachricht löschen"): a name of two to four words ending in a final's word
//   plain    whole names a press is known to be plain (OK, Cancel, Bold): with the finals, the words Gnomon knows on a button
//   composer the words of the button a message box sends with (Send, Post, Reply, Comment, Submit)
//   talk     how a message box names whom it writes to ("Message #general"): the words before the name
//   returns  words of a box (or its container) whose Return runs or sends a line: a terminal, a chat, a search
// The Papiamento row is short: only words the owner can confirm on sight; add to it there.

/** Kinds in the order they are checked: "Delete draft" discards before "Delete" deletes, "Place order" submits before it posts. */
export const KINDS = ['discard', 'send', 'pay', 'submit', 'delete', 'post', 'update', 'overwrite', 'archive', 'leave', 'block', 'share', 'transfer', 'merge', 'answer']

export const LANGUAGES = {
  en: {
    finals: {
      discard: ["don['’]?t save", 'do not save', 'discard', 'delete draft', 'revert', 'close without saving'],
      send: ['send'],
      pay: ['pay', 'buy', 'purchase', 'check\\s*out'],
      submit: ['submit', 'place (?:my |your |the )?order', 'confirm'],
      // S5R1: Unsend takes a message back from everyone; Erase wipes a disk.
      delete: ['delete', 'move to (?:the )?(?:trash|bin)', 'empty (?:the )?(?:trash|bin)', 'remove', 'erase', 'unsend'],
      post: ['post', 'publish', 'tweet', 'repost', 'reply all'],
      // Set 2 R4: an update prompt's go; its Later, Not Now, Remind Me Later and Skip are plain.
      update: ['update', 'install', 'upgrade', 'restart now'],
      overwrite: ['replace', 'overwrite'],
      archive: ['archive'],
      leave: ['leave', 'unsubscribe'],
      block: ['block', 'revoke'],
      share: ['share', 'invite'],
      transfer: ['transfer'],
      // S5R1: Merge alone or with its object. Merge All Windows or Merge Cells is layout.
      merge: ['(?:squash|rebase) and merge', 'merge(?: (?:pull request|request|branch|now|changes))?\\s*$'],
      answer: ['approve', 'accept', 'decline'],
    },
    not: { leave: ['a', 'an', 'feedback', 'comment', 'review', 'blank', 'unchanged', 'as'], block: ['quote'], answer: ['all', 'cookies', 'optional'] },
    plain: ['ok', 'okay', 'cancel', 'close', 'back', 'next', 'previous', 'continue', 'done', 'open', 'save', 'save as', 'bold', 'italic', 'underline', 'reload', 'refresh', 'info', 'forward', 'reply', 'new', 'edit', 'undo', 'redo', 'copy', 'paste', 'cut', 'find', 'search', 'print', 'show', 'hide', 'more', 'settings', 'preferences', 'help', 'yes', 'no', 'not now', 'later', 'remind me later', 'skip', 'try again', 'retry', 'dismiss', 'got it', 'view', 'preview', 'minimize', 'zoom', 'full screen', 'expand', 'collapse', 'select all', 'sort', 'filter', 'play', 'pause', 'stop'],
    composer: ['send', 'post', 'reply', 'comment', 'submit'],
    talk: ['message', 'reply to', 'send a message to', 'write to', 'chat with'],
    returns: ['terminal', 'console', 'shell', 'chat', 'prompt', 'ask', 'message', 'assistant', 'command', 'search', 'reply', 'comment'],
  },
  nl: {
    last: true,
    finals: {
      discard: ['niet bewaren', 'niet opslaan', 'bewaar niet', 'sla niet op', 'weggooien', 'gooi weg', 'verwerpen', 'concept verwijderen', 'verwijder concept', 'sluiten zonder (?:bewaren|opslaan)', 'terugzetten'],
      send: ['verzenden', 'verzend', 'versturen', 'verstuur', 'stuur'],
      pay: ['betalen', 'betaal', 'kopen', 'koop', 'nu kopen', 'afrekenen', 'reken af'],
      submit: ['bestelling plaatsen', 'plaats bestelling', 'bestellen', 'bestel', 'indienen', 'dien in', 'insturen', 'bevestigen', 'bevestig'],
      delete: ['verwijderen', 'verwijder', 'wissen', 'wis', 'verplaats naar (?:de )?prullenmand', 'naar prullenmand', 'leeg (?:de )?prullenmand', 'prullenmand legen', 'verzenden ongedaan maken'],
      post: ['publiceren', 'publiceer', 'plaatsen', 'plaats', 'posten', 'allen beantwoorden', 'beantwoord allen'],
      update: ['bijwerken', 'werk bij', 'installeren', 'installeer', 'upgraden', 'updaten', 'nu herstarten', 'herstart nu', 'nu opnieuw opstarten'],
      overwrite: ['vervangen', 'vervang', 'overschrijven', 'overschrijf'],
      archive: ['archiveren', 'archiveer'],
      leave: ['verlaten', 'verlaat', 'uitschrijven', 'schrijf uit'],
      block: ['blokkeren', 'blokkeer', 'intrekken', 'trek in'],
      share: ['delen', 'deel', 'uitnodigen', 'nodig uit'],
      transfer: ['overmaken', 'maak over', 'overboeken', 'overdragen', 'draag over'],
      merge: ['samenvoegen\\s*$', 'voeg samen\\s*$'],
      answer: ['goedkeuren', 'keur goed', 'accepteren', 'accepteer', 'weigeren', 'weiger', 'afwijzen', 'wijs af', 'afslaan'],
    },
    not: { send: ['door', 'ongedaan'], answer: ['alle', 'alles', 'cookies', 'optionele'], merge: ['cellen', 'vensters'] },
    plain: ['annuleer', 'annuleren', 'sluit', 'sluiten', 'terug', 'volgende', 'vorige', 'ga door', 'doorgaan', 'verder', 'gereed', 'klaar', 'openen', 'bewaar', 'bewaren', 'opslaan', 'bewaar als', 'vet', 'cursief', 'onderstreept', 'vernieuw', 'vernieuwen', 'opnieuw laden', 'doorsturen', 'stuur door', 'beantwoord', 'antwoord', 'nieuw', 'wijzig', 'bewerk', 'ongedaan maken', 'opnieuw', 'kopieer', 'plak', 'knip', 'zoek', 'zoeken', 'druk af', 'toon', 'verberg', 'meer', 'instellingen', 'voorkeuren', 'ja', 'nee', 'niet nu', 'later', 'sla over', 'overslaan', 'probeer opnieuw', 'begrepen', 'bekijk', 'stop'],
    composer: ['verzenden', 'verstuur', 'stuur', 'plaatsen', 'plaats', 'beantwoorden', 'beantwoord', 'antwoorden', 'antwoord', 'reageren', 'reageer', 'reactie', 'indienen'],
    talk: ['bericht aan', 'bericht naar', 'stuur een bericht naar', 'bericht', 'antwoord aan', 'schrijf aan'],
    returns: ['opdracht', 'bericht', 'vraag', 'zoek', 'antwoord', 'reactie', 'reageer'],
  },
  de: {
    last: true,
    finals: {
      discard: ['nicht sichern', 'nicht speichern', 'verwerfen', 'entwurf löschen', 'schließen ohne (?:zu )?(?:sichern|speichern)', 'ohne (?:sichern|speichern) schließen', 'zurücksetzen'],
      send: ['senden', 'sende', 'absenden', 'verschicken', 'abschicken'],
      pay: ['bezahlen', 'zahlen', 'kaufen', 'jetzt kaufen', 'zur kasse'],
      submit: ['(?:kostenpflichtig|zahlungspflichtig) bestellen', 'bestellung aufgeben', 'bestellen', 'einreichen', 'bestätigen'],
      delete: ['löschen', 'lösche', 'entfernen', 'entferne', 'in den papierkorb (?:legen|bewegen)', 'papierkorb (?:entleeren|leeren)', 'senden widerrufen'],
      post: ['veröffentlichen', 'posten', 'allen antworten'],
      update: ['aktualisieren', 'installieren', 'jetzt neu starten', 'upgraden'],
      overwrite: ['ersetzen', 'überschreiben'],
      archive: ['archivieren'],
      leave: ['verlassen', 'abbestellen', 'austreten'],
      block: ['blockieren', 'sperren', 'widerrufen', 'entziehen'],
      share: ['teilen', 'freigeben', 'einladen'],
      transfer: ['überweisen', 'übertragen'],
      merge: ['zusammenführen\\s*$'],
      answer: ['genehmigen', 'annehmen', 'akzeptieren', 'ablehnen', 'zusagen', 'absagen'],
    },
    not: { send: ['widerrufen'], answer: ['alle', 'alles', 'cookies', 'optionale'], merge: ['zellen', 'fenster'] },
    plain: ['abbrechen', 'schließen', 'zurück', 'weiter', 'fertig', 'öffnen', 'sichern', 'speichern', 'sichern unter', 'speichern unter', 'fett', 'kursiv', 'unterstrichen', 'neu laden', 'weiterleiten', 'antworten', 'neu', 'bearbeiten', 'kopieren', 'einsetzen', 'einfügen', 'ausschneiden', 'suchen', 'drucken', 'anzeigen', 'ausblenden', 'mehr', 'einstellungen', 'hilfe', 'ja', 'nein', 'nicht jetzt', 'später', 'überspringen', 'erneut versuchen', 'verstanden'],
    composer: ['senden', 'absenden', 'posten', 'antworten', 'kommentieren', 'kommentar', 'einreichen'],
    talk: ['nachricht an', 'nachricht', 'antworten an', 'schreiben an'],
    returns: ['befehl', 'nachricht', 'frage', 'suche', 'antwort', 'kommentar'],
  },
  fr: {
    finals: {
      discard: ['ne pas enregistrer', 'supprimer le brouillon', 'abandonner les modifications', 'fermer sans enregistrer', 'revenir à la version enregistrée'],
      send: ['envoyer', 'envoie'],
      pay: ['payer', 'acheter', 'régler'],
      submit: ['passer (?:la )?commande', 'valider (?:la |ma )?commande', 'commander', 'soumettre', 'confirmer'],
      delete: ['supprimer', 'effacer', 'retirer', '(?:placer|mettre|déplacer) (?:dans|à) la corbeille', 'vider la corbeille', "annuler l['’]envoi"],
      post: ['publier', 'poster', 'répondre à tous'],
      update: ['mettre à jour', 'installer', 'redémarrer maintenant'],
      overwrite: ['remplacer', 'écraser'],
      archive: ['archiver'],
      // "Quitter" alone quits an app (Quitter Safari); leaving a meeting or a group names it.
      leave: ['quitter (?:la|le|les|ce|cette)', "quitter l['’]\\S+", 'se désabonner', 'désabonner', 'se désinscrire'],
      block: ['bloquer', 'révoquer'],
      share: ['partager', 'inviter'],
      transfer: ['transférer (?:la propriété|l[\'’]argent|des fonds)', 'virer', 'effectuer le virement'],
      merge: ['fusionner\\s*$', 'fusionner la (?:demande|branche)'],
      answer: ['approuver', 'accepter', 'refuser', 'décliner'],
    },
    not: { answer: ['tout', 'tous', 'les cookies', 'cookies', 'et fermer'] },
    plain: ['annuler', 'fermer', 'retour', 'précédent', 'suivant', 'continuer', 'terminé', 'ouvrir', 'enregistrer', 'enregistrer sous', 'gras', 'italique', 'souligné', 'actualiser', 'recharger', 'infos', 'transférer', 'répondre', 'nouveau', 'modifier', 'copier', 'coller', 'couper', 'rechercher', 'imprimer', 'afficher', 'masquer', 'plus', 'réglages', 'préférences', 'aide', 'oui', 'non', 'pas maintenant', 'plus tard', 'ignorer', 'réessayer', 'compris'],
    composer: ['envoyer', 'publier', 'répondre', 'commenter', 'soumettre'],
    talk: ['envoyer un message à', 'message à', 'message', 'répondre à', 'écrire à'],
    returns: ['commande', 'message', 'question', 'recherche', 'réponse', 'commentaire'],
  },
  es: {
    finals: {
      discard: ['no guardar', 'descartar', 'eliminar borrador', 'cerrar sin guardar', 'revertir'],
      send: ['enviar', 'envía'],
      pay: ['pagar', 'comprar', 'finalizar compra', 'tramitar pedido'],
      submit: ['realizar (?:el )?pedido', 'hacer (?:el )?pedido', 'confirmar'],
      delete: ['eliminar', 'borrar', 'quitar', '(?:mover|trasladar) a la papelera', 'vaciar (?:la )?papelera', 'anular envío'],
      post: ['publicar', 'responder a todos'],
      update: ['actualizar', 'instalar', 'reiniciar ahora'],
      overwrite: ['reemplazar', 'sustituir', 'sobrescribir'],
      archive: ['archivar'],
      // "Salir" alone quits an app; leaving names what it leaves.
      leave: ['salir del?', 'abandonar', 'darse de baja', 'cancelar (?:la )?suscripción'],
      block: ['bloquear', 'revocar'],
      share: ['compartir', 'invitar'],
      transfer: ['transferir'],
      merge: ['fusionar\\s*$', 'fusionar (?:la )?(?:solicitud|rama)'],
      // "Aceptar" alone is a Spanish dialog's OK: an answer names what it accepts.
      answer: ['aprobar', 'aceptar(?= )', 'rechazar'],
    },
    not: { answer: ['todo', 'todas', 'todos', 'cookies', 'las cookies'] },
    plain: ['aceptar', 'cancelar', 'cerrar', 'atrás', 'volver', 'siguiente', 'anterior', 'continuar', 'listo', 'hecho', 'abrir', 'guardar', 'guardar como', 'negrita', 'cursiva', 'subrayado', 'recargar', 'reenviar', 'responder', 'nuevo', 'editar', 'deshacer', 'rehacer', 'copiar', 'pegar', 'cortar', 'buscar', 'imprimir', 'mostrar', 'ocultar', 'más', 'ajustes', 'preferencias', 'ayuda', 'sí', 'no', 'ahora no', 'más tarde', 'omitir', 'reintentar', 'entendido'],
    composer: ['enviar', 'publicar', 'responder', 'comentar', 'presentar'],
    talk: ['enviar mensaje a', 'mensaje a', 'mensaje para', 'mensaje', 'responder a', 'escribir a'],
    returns: ['comando', 'mensaje', 'pregunta', 'buscar', 'búsqueda', 'respuesta', 'comentario'],
  },
  pt: {
    finals: {
      discard: ['não salvar', 'não guardar', 'descartar', '(?:apagar|excluir|eliminar) rascunho', 'fechar sem (?:salvar|guardar)', 'reverter'],
      send: ['enviar', 'envia'],
      pay: ['pagar', 'comprar', 'finalizar compra'],
      submit: ['fazer (?:o )?pedido', 'finalizar pedido', 'submeter', 'confirmar'],
      delete: ['excluir', 'apagar', 'eliminar', 'remover', 'mover para (?:o )?(?:lixo|lixeira)', 'esvaziar (?:o )?(?:lixo|lixeira)', 'cancelar envio'],
      post: ['publicar', 'responder a todos'],
      update: ['atualizar', 'instalar', 'reiniciar agora'],
      overwrite: ['substituir', 'sobrescrever', 'substituir tudo'],
      archive: ['arquivar'],
      leave: ['sair d[aoe]s?', 'abandonar', 'cancelar (?:a )?(?:inscrição|assinatura)', 'descadastrar'],
      block: ['bloquear', 'revogar'],
      share: ['compartilhar', 'partilhar', 'convidar'],
      transfer: ['transferir'],
      merge: ['mesclar\\s*$', 'mesclar (?:a )?(?:solicitação|branch)'],
      answer: ['aprovar', 'aceitar', 'recusar', 'rejeitar'],
    },
    not: { answer: ['tudo', 'todos', 'cookies', 'os cookies'] },
    plain: ['cancelar', 'fechar', 'voltar', 'seguinte', 'próximo', 'anterior', 'continuar', 'concluído', 'ok', 'abrir', 'salvar', 'guardar', 'salvar como', 'guardar como', 'negrito', 'itálico', 'sublinhado', 'recarregar', 'reencaminhar', 'encaminhar', 'responder', 'novo', 'editar', 'desfazer', 'refazer', 'copiar', 'colar', 'recortar', 'buscar', 'procurar', 'pesquisar', 'imprimir', 'mostrar', 'ocultar', 'mais', 'ajustes', 'preferências', 'ajuda', 'sim', 'não', 'agora não', 'mais tarde', 'ignorar', 'pular', 'tentar novamente', 'entendi'],
    composer: ['enviar', 'publicar', 'responder', 'comentar', 'submeter'],
    talk: ['enviar mensagem para', 'mensagem para', 'mensagem', 'responder a', 'escrever para'],
    returns: ['comando', 'mensagem', 'pergunta', 'pesquisa', 'resposta', 'comentário'],
  },
  it: {
    finals: {
      discard: ['non salvare', 'scarta', 'elimina bozza', 'chiudi senza salvare', 'ripristina'],
      send: ['invia', 'inviare', 'manda'],
      pay: ['paga', 'pagare', 'acquista', 'compra'],
      submit: ['effettua (?:l[\'’])?ordine', 'conferma (?:l[\'’])?ordine', 'ordina ora', 'conferma'],
      delete: ['elimina', 'eliminare', 'cancella', 'rimuovi', 'sposta nel cestino', 'svuota (?:il )?cestino', "annulla l['’]invio"],
      post: ['pubblica', 'pubblicare', 'rispondi a tutti'],
      update: ['aggiorna', 'installa', 'riavvia ora'],
      overwrite: ['sostituisci', 'sovrascrivi'],
      archive: ['archivia'],
      leave: ['abbandona', 'esci da(?:l|lla|i|gli)?', 'annulla (?:l[\'’])?iscrizione', 'disiscriviti'],
      block: ['blocca', 'revoca'],
      share: ['condividi', 'invita'],
      transfer: ['trasferisci', 'trasferire'],
      merge: ['unisci\\s*$', 'esegui (?:il )?merge'],
      answer: ['approva', 'accetta', 'rifiuta', 'declina'],
    },
    not: { answer: ['tutto', 'tutti', 'cookie', 'i cookie'] },
    plain: ['annulla', 'chiudi', 'indietro', 'avanti', 'successivo', 'precedente', 'continua', 'fine', 'fatto', 'apri', 'salva', 'salva con nome', 'grassetto', 'corsivo', 'sottolineato', 'ricarica', 'inoltra', 'rispondi', 'nuovo', 'modifica', 'copia', 'incolla', 'taglia', 'cerca', 'stampa', 'mostra', 'nascondi', 'altro', 'impostazioni', 'preferenze', 'aiuto', 'sì', 'no', 'non ora', 'più tardi', 'salta', 'riprova', 'ho capito'],
    composer: ['invia', 'pubblica', 'rispondi', 'commenta'],
    talk: ['invia un messaggio a', 'messaggio a', 'messaggio', 'rispondi a', 'scrivi a'],
    returns: ['comando', 'messaggio', 'domanda', 'cerca', 'ricerca', 'risposta', 'commento'],
  },
  pap: {
    finals: {
      discard: ['no warda'],
      send: ['manda'],
      pay: ['paga', 'kumpra'],
      submit: ['konfirm[aá]'],
      delete: ['kita', 'elimin[aá]', 'bor[aá]'],
      post: ['publik[aá]'],
      share: ['kompart[ií]'],
      answer: ['aprob[aá]', 'asept[aá]', 'rechas[aá]'],
    },
    not: { answer: ['tur'] },
    plain: ['kansel[aá]', 'sera', 'habri', 'warda', 'sí', 'no', 'bèk', 'sigui'],
    composer: ['manda'],
    talk: [],
    returns: [],
  },
}

const LETTER = '[\\p{L}\\p{N}]'
const spaced = (src) => src.replace(/ /g, '\\s+')
const any = (list) => list.map(spaced).join('|')
const after = (not) => (not?.length ? `(?!\\s+(?:${any(not)})(?!${LETTER}))` : '')
/** A name that starts with one of `words` as a whole word, unless one of `not` comes right after it. */
const starts = (words, not) => `^\\s*(?:${any(words)})(?!${LETTER})${after(not)}`
/** A name of two to four words that ends in one of `words`, none of the words before it one of `not` (verb-last languages). */
const ends = (words, not) => `^\\s*(?:${not?.length ? `(?!(?:${any(not)})(?!${LETTER}))` : ''}[\\p{L}\\p{N}'’.-]+\\s+){1,3}(?:${any(words)})\\s*$`
const langs = Object.values(LANGUAGES)
const compile = (parts) => new RegExp(parts.join('|') || '(?!)', 'iu')
/** One pattern per kind, every language at once. */
export const FINAL_RES = KINDS.map((kind) => [kind, compile(langs.flatMap((l) => (l.finals[kind]?.length ? [starts(l.finals[kind], l.not?.[kind]), ...(l.last ? [ends(l.finals[kind], l.not?.[kind])] : [])] : [])))])
export const finalRe = (kind) => FINAL_RES.find(([k]) => k === kind)?.[1]

/** The S5R1 kinds whose control, when its name ends in an ellipsis (Share…, Replace…), only opens a sheet or a menu: the final is in there. */
const OPENS_MORE = new Set(['overwrite', 'archive', 'leave', 'block', 'share', 'transfer', 'merge', 'answer'])
const ELLIPSIS = /(?:…|\.\.\.)\s*$/
/** The kind of final a control's name names, or null. Navigation is never a final: Forward opens a draft, whose Send is the final. */
export const finalWord = (words) => {
  const kind = typeof words === 'string' ? (FINAL_RES.find(([, re]) => re.test(words))?.[0] ?? null) : null
  return kind && OPENS_MORE.has(kind) && ELLIPSIS.test(words) ? null : kind
}

const PLAIN = new RegExp(`^\\s*(?:${langs.map((l) => any(l.plain)).filter(Boolean).join('|')})\\s*[.!]?\\s*$`, 'iu')
/** Whether a button's name is one Gnomon knows: a final's, a plain word's (whole), or one that ends in an ellipsis (it opens more first). */
export const knownButton = (words) => typeof words === 'string' && words.trim() !== '' && (finalWord(words) !== null || PLAIN.test(words) || ELLIPSIS.test(words))

/** The words of the button a message box sends with, in any language. */
export const COMPOSER = compile(langs.flatMap((l) => (l.composer.length ? [starts(l.composer), ...(l.last ? [ends(l.composer)] : [])] : [])))
/** Words of a box, or of its container, whose Return runs a line or sends it (a prefix of a word: "chat" holds "chatten"). */
export const RUNS_RETURN = new RegExp(`(?<!${LETTER})(?:${langs.map((l) => any(l.returns)).filter(Boolean).join('|')})`, 'iu')
const TALK = new RegExp(`^\\s*(?:${langs.flatMap((l) => l.talk).sort((a, b) => b.length - a.length).map(spaced).join('|')})\\s+(.+?)\\s*$`, 'iu')
/** The conversation a message box names ("Message #general", "Bericht aan Mira Bakker"), or null. */
export const talkOf = (name) => TALK.exec(String(name ?? ''))?.[1] ?? null
