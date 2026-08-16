package dev.atomicdata

/**
 * Well-known Atomic Data class and property URLs.
 *
 * Same constants as `atomic_data.urls` in Python. These are plain strings so
 * they can be used without loading the native library.
 */
object Urls {
    const val CLASS = "https://atomicdata.dev/classes/Class"
    const val PROPERTY = "https://atomicdata.dev/classes/Property"
    const val AGENT = "https://atomicdata.dev/classes/Agent"
    const val DRIVE = "https://atomicdata.dev/classes/Drive"
    const val FOLDER = "https://atomicdata.dev/classes/Folder"
    const val FILE = "https://atomicdata.dev/classes/File"
    const val COMMIT = "https://atomicdata.dev/classes/Commit"
    const val CHATROOM = "https://atomicdata.dev/classes/ChatRoom"
    const val MESSAGE = "https://atomicdata.dev/classes/Message"
    const val DOCUMENT_V2 = "https://atomicdata.dev/classes/DocumentV2"
    const val TABLE = "https://atomicdata.dev/classes/Table"
    const val TAG = "https://atomicdata.dev/classes/Tag"
    const val PLAIN_TEXT = "https://atomicdata.dev/classes/PlainText"
    const val FORK = "https://atomicdata.dev/classes/Fork"
    const val ONTOLOGY = "https://atomicdata.dev/classes/Ontology"
    const val BOOKMARK = "https://atomicdata.dev/classes/Bookmark"

    const val NAME = "https://atomicdata.dev/properties/name"
    const val DESCRIPTION = "https://atomicdata.dev/properties/description"
    const val SHORTNAME = "https://atomicdata.dev/properties/shortname"
    const val IS_A = "https://atomicdata.dev/properties/isA"
    const val PARENT = "https://atomicdata.dev/properties/parent"
    const val READ = "https://atomicdata.dev/properties/read"
    const val WRITE = "https://atomicdata.dev/properties/write"
    const val CHILDREN = "https://atomicdata.dev/properties/children"
    const val DRIVES = "https://atomicdata.dev/properties/drives"
    const val DATATYPE = "https://atomicdata.dev/properties/datatype"
    const val CLASSTYPE = "https://atomicdata.dev/properties/classtype"
    const val REQUIRES = "https://atomicdata.dev/properties/requires"
    const val RECOMMENDS = "https://atomicdata.dev/properties/recommends"
    const val CREATED_AT = "https://atomicdata.dev/properties/createdAt"
    const val CREATED_BY = "https://atomicdata.dev/properties/createdBy"
    const val PUBLIC_KEY = "https://atomicdata.dev/properties/publicKey"
    const val SUBJECT = "https://atomicdata.dev/properties/subject"
    const val SIGNER = "https://atomicdata.dev/properties/signer"
    const val DRIVE_PROP = "https://atomicdata.dev/properties/drive"
    const val PERSONAL_DRIVE = "https://atomicdata.dev/properties/personalDrive"
    const val LANGUAGE = "https://atomicdata.dev/properties/language"
}
