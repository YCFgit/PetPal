const identity = 'VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin';
const timestamp = 'CHAR(24) CHARACTER SET ascii COLLATE ascii_bin';
const table = (name: string, columns: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

export const migrationTable = table('schema_migrations', 'version INT PRIMARY KEY, checksum CHAR(64) NOT NULL');

export const migrations = [{
  version: 1,
  statements: [
  table('user_locks', `id ${identity} PRIMARY KEY`),
  table('services', `id ${identity} PRIMARY KEY, name VARCHAR(200) NOT NULL, petType ENUM('CAT','DOG') NOT NULL,
    durationMinutes INT UNSIGNED NOT NULL, basePriceFen BIGINT UNSIGNED NOT NULL,
    extraPetPriceFen BIGINT UNSIGNED NOT NULL, maxPets INT UNSIGNED NOT NULL,
    priceVersion VARCHAR(100) NOT NULL, ruleVersion VARCHAR(100) NOT NULL, active BOOLEAN NOT NULL`),
  table('pets', `id ${identity} PRIMARY KEY, userId ${identity} NOT NULL, name VARCHAR(80) NOT NULL,
    type ENUM('CAT','DOG') NOT NULL, careNotes VARCHAR(2000) NOT NULL, INDEX pets_owner(userId)`),
  table('addresses', `id ${identity} PRIMARY KEY, userId ${identity} NOT NULL, areaId ${identity} NOT NULL,
    label VARCHAR(200) NOT NULL, INDEX addresses_owner(userId)`),
  table('slots', `id ${identity} PRIMARY KEY, serviceId ${identity} NOT NULL, areaId ${identity} NOT NULL,
    startsAt ${timestamp} NOT NULL, endsAt ${timestamp} NOT NULL, capacity INT UNSIGNED NOT NULL,
    reserved INT UNSIGNED NOT NULL, active BOOLEAN NOT NULL,
    CHECK (reserved <= capacity), CHECK (endsAt > startsAt),
    FOREIGN KEY(serviceId) REFERENCES services(id), INDEX slots_catalog(serviceId,areaId,active,startsAt)`),
  table('quotes', `id ${identity} PRIMARY KEY, userId ${identity} NOT NULL, input JSON NOT NULL,
    serviceSnapshot JSON NOT NULL, petSnapshots JSON NOT NULL, addressSnapshot JSON NOT NULL,
    slotSnapshot JSON NOT NULL, amountFen BIGINT UNSIGNED NOT NULL, currency ENUM('CNY') NOT NULL,
    createdAt ${timestamp} NOT NULL, expiresAt ${timestamp} NOT NULL, INDEX quotes_owner(userId)`),
  table('orders', `id ${identity} PRIMARY KEY, userId ${identity} NOT NULL, quoteId ${identity} NOT NULL UNIQUE,
    status ENUM('PENDING_PAYMENT','CANCELLED') NOT NULL, paymentStatus ENUM('UNPAID') NOT NULL,
    paymentChannelSubmitted BOOLEAN NOT NULL, amountFen BIGINT UNSIGNED NOT NULL, currency ENUM('CNY') NOT NULL,
    snapshot JSON NOT NULL, createdAt ${timestamp} NOT NULL, paymentDeadline ${timestamp} NOT NULL,
    cancelledAt ${timestamp} NULL, version INT UNSIGNED NOT NULL,
    CHECK(amountFen > 0), FOREIGN KEY(quoteId) REFERENCES quotes(id),
    INDEX orders_owner(userId,createdAt DESC,id DESC), INDEX orders_due(status,paymentChannelSubmitted,paymentDeadline)`),
  table('order_resources', `orderId ${identity} NOT NULL, kind ENUM('pet','address') NOT NULL,
    resourceId ${identity} NOT NULL, PRIMARY KEY(orderId,kind,resourceId),
    FOREIGN KEY(orderId) REFERENCES orders(id), INDEX resources_lookup(kind,resourceId,orderId)`),
  table('reservations', `orderId ${identity} PRIMARY KEY, slotId ${identity} NOT NULL,
    status ENUM('HELD','RELEASED') NOT NULL, FOREIGN KEY(orderId) REFERENCES orders(id),
    FOREIGN KEY(slotId) REFERENCES slots(id), INDEX reservations_slot(slotId)`),
  table('idempotency', `id VARCHAR(400) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    fingerprint CHAR(64) CHARACTER SET ascii NOT NULL, orderId ${identity} NOT NULL,
    FOREIGN KEY(orderId) REFERENCES orders(id)`),
  table('order_events', `id ${identity} PRIMARY KEY, orderId ${identity} NOT NULL, actorId ${identity} NOT NULL,
    kind ENUM('ORDER_CREATED','USER_CANCELLED','PAYMENT_EXPIRED') NOT NULL,
    createdAt ${timestamp} NOT NULL, requestId ${identity} NOT NULL,
    FOREIGN KEY(orderId) REFERENCES orders(id), INDEX events_order(orderId,createdAt)`),
  ],
}] as const;

export const schemaVersion = migrations.at(-1)?.version ?? 0;
