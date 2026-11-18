// Finals in other languages (owner decision 2026-11-17): a Dutch "Verzenden" is a Send. A few words and the exceptions per
// language, the ellipsis rule, and the gate asking on them. Every value is made up.
import { describe, expect, it } from 'vitest'
import { composerFinal, finalOf } from './gate-finals.js'
import { finalWord, knownButton, LANGUAGES, talkOf } from './final-words.js'

const FINALS = {
  nl: { Verzenden: 'send', Verstuur: 'send', 'Niet bewaren': 'discard', 'Concept verwijderen': 'discard', Verwijderen: 'delete', 'Bericht verwijderen': 'delete', 'Verplaats naar prullenmand': 'delete', Betalen: 'pay', 'Nu kopen': 'pay', 'Bestelling plaatsen': 'submit', Publiceren: 'post', Bijwerken: 'update', Vervangen: 'overwrite', Archiveren: 'archive', 'Gesprek archiveren': 'archive', 'Kanaal verlaten': 'leave', Blokkeren: 'block', Delen: 'share', Overmaken: 'transfer', Samenvoegen: 'merge', Accepteren: 'answer', 'Uitnodiging accepteren': 'answer', 'Verzenden ongedaan maken': 'delete' },
  de: { Senden: 'send', 'Nicht sichern': 'discard', 'Entwurf löschen': 'discard', Löschen: 'delete', 'Nachricht löschen': 'delete', 'Papierkorb entleeren': 'delete', 'Jetzt kaufen': 'pay', 'Zahlungspflichtig bestellen': 'submit', Veröffentlichen: 'post', Ersetzen: 'overwrite', Archivieren: 'archive', 'Kanal verlassen': 'leave', Blockieren: 'block', Teilen: 'share', Überweisen: 'transfer', Zusammenführen: 'merge', Ablehnen: 'answer', 'Senden widerrufen': 'delete' },
  fr: { Envoyer: 'send', 'Ne pas enregistrer': 'discard', Supprimer: 'delete', 'Vider la corbeille': 'delete', Payer: 'pay', 'Passer la commande': 'submit', Publier: 'post', 'Mettre à jour': 'update', Remplacer: 'overwrite', Archiver: 'archive', 'Quitter la réunion': 'leave', "Quitter l'appel": 'leave', Bloquer: 'block', Partager: 'share', Fusionner: 'merge', Refuser: 'answer' },
  es: { Enviar: 'send', 'No guardar': 'discard', Eliminar: 'delete', Borrar: 'delete', Pagar: 'pay', 'Realizar pedido': 'submit', Publicar: 'post', Reemplazar: 'overwrite', Archivar: 'archive', 'Salir del grupo': 'leave', Bloquear: 'block', Compartir: 'share', Transferir: 'transfer', 'Aceptar invitación': 'answer', Rechazar: 'answer' },
  pt: { Enviar: 'send', 'Não salvar': 'discard', Excluir: 'delete', Apagar: 'delete', Comprar: 'pay', Publicar: 'post', Substituir: 'overwrite', Arquivar: 'archive', 'Sair do grupo': 'leave', Compartilhar: 'share', Partilhar: 'share', Mesclar: 'merge', Aceitar: 'answer' },
  it: { Invia: 'send', 'Non salvare': 'discard', Elimina: 'delete', Cancella: 'delete', Paga: 'pay', Acquista: 'pay', 'Effettua ordine': 'submit', Pubblica: 'post', Sostituisci: 'overwrite', Archivia: 'archive', Abbandona: 'leave', Blocca: 'block', Condividi: 'share', Trasferisci: 'transfer', Rifiuta: 'answer' },
  pap: { Manda: 'send', 'No warda': 'discard', Kita: 'delete', Kumpra: 'pay', Publiká: 'post', Kompartí: 'share', Aseptá: 'answer' },
}
const PLAIN = {
  nl: ['Annuleer', 'Gereed', 'Stuur door', 'Alle cookies accepteren', 'Accepteer alle cookies', 'Cookies weigeren', 'Cellen samenvoegen', 'Gedeeld met mij', 'Gearchiveerd'],
  de: ['Abbrechen', 'Fertig', 'Alle akzeptieren', 'Cookies ablehnen', 'Zellen zusammenführen'],
  fr: ['Annuler', 'Terminé', 'Quitter', 'Quitter Safari', 'Tout accepter', 'Accepter tous les cookies', 'Refuser les cookies', 'Fusionner les cellules', 'Transférer'],
  es: ['Cancelar', 'Aceptar', 'Salir', 'Aceptar todo', 'Rechazar todas', 'Aceptar las cookies'],
  pt: ['Cancelar', 'Aceitar tudo', 'Recusar cookies', 'Sair'],
  it: ['Annulla', 'Accetta tutti', 'Rifiuta tutti', 'Inoltra', 'Ordina'],
  pap: ['Kansela', 'Aseptá tur'],
}

describe('finalWord in every language', () => {
  for (const [lang, words] of Object.entries(FINALS))
    it(`${lang}: each word is a final of its kind`, () => {
      for (const [label, kind] of Object.entries(words)) expect(finalWord(label), label).toBe(kind)
      expect(finalWord(Object.keys(words)[0].toUpperCase()), 'upper case').toBe(Object.values(words)[0])
    })
  for (const [lang, labels] of Object.entries(PLAIN))
    it(`${lang}: cookie banners, layout, quitting an app and navigation are not finals`, () => {
      for (const label of labels) expect(finalWord(label), label).toBeNull()
    })
  it('the ellipsis rule holds in every language: Delen…, Teilen…, Partager…, Archiver… only open more', () => {
    for (const label of ['Delen…', 'Teilen...', 'Partager…', 'Archiver…', 'Vervangen…', 'Condividi…']) expect(finalWord(label), label).toBeNull()
    // A send, a delete or a payment with an ellipsis is still one.
    for (const label of ['Verzenden…', 'Löschen…', 'Pagar…']) expect(finalWord(label), label).not.toBeNull()
  })
  it('a word inside another word is no final: Versturend, Löschung, Envoyeur', () => {
    for (const label of ['Versturend', 'Löschung', 'Envoyeur', 'Delenda']) expect(finalWord(label), label).toBeNull()
  })
  it('every language has a table entry for each part it fills', () => {
    for (const [lang, l] of Object.entries(LANGUAGES)) expect(Object.keys(l).filter((k) => !['last', 'not'].includes(k)).sort(), lang).toEqual(['composer', 'finals', 'plain', 'returns', 'talk'])
  })
})

describe('the gate reads them: a press, a composer, a message box', () => {
  it('a press on Verzenden asks as a send; on Annuleren it takes no final', () => {
    expect(finalOf('screen_act', { app: 'Lantern', role: 'button', label: 'Verzenden' })).toMatchObject({ kind: 'send', what: 'Verzenden' })
    expect(finalOf('screen_act', { app: 'Lantern', role: 'button', label: 'Nachricht löschen' })).toMatchObject({ kind: 'delete' })
    expect(finalOf('screen_act', { app: 'Lantern', role: 'button', label: 'Annuleren' })).toBeNull()
  })
  it("a message box with a Dutch Verzenden beside it sends on Return; the box's name says to whom", () => {
    const box = { ref: 'e1', role: 'AXTextArea', label: 'Bericht aan #puzzlebox', frame: [0, 500, 400, 40], settable: true }
    const look = { app: 'Lantern', elements: [box, { ref: 'e2', role: 'AXButton', label: 'Verzenden', frame: [410, 500, 60, 40] }] }
    expect(composerFinal(look, box)).toBe('Verzenden')
    expect(talkOf('Bericht aan #puzzlebox')).toBe('#puzzlebox')
    expect(talkOf('Nachricht an Mira Bakker')).toBe('Mira Bakker')
    expect(talkOf('Message #general')).toBe('#general')
  })
})

describe('knownButton: the words Gnomon knows on a button', () => {
  it('a final, a plain word or an ellipsis is known, in any language', () => {
    for (const label of ['Send', 'Verzenden', 'OK', 'Annuleren', 'Abbrechen', 'Bold', 'Vet', 'Export…', 'Save as'])
      expect(knownButton(label), label).toBe(true)
  })
  it('anything else is unknown: a made-up word, an icon name, no words', () => {
    for (const label of ['Frobnicate', 'Zap it', 'e12', '', '   ', undefined]) expect(knownButton(label), String(label)).toBe(false)
  })
})
