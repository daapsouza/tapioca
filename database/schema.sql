CREATE DATABASE IF NOT EXISTS comanda_virtual
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE comanda_virtual;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product ENUM('tapioca', 'omelete') NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  room VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_orders_created_at (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_ingredients (
  order_id BIGINT UNSIGNED NOT NULL,
  ingredient VARCHAR(40) NOT NULL,
  PRIMARY KEY (order_id, ingredient),
  CONSTRAINT fk_order_ingredients_order
    FOREIGN KEY (order_id) REFERENCES orders(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
