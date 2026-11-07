#ifndef OURMUSIC_HAL_ASIO_H
#define OURMUSIC_HAL_ASIO_H

#include "hal.h"

size_t om_asio_enumerate_devices(om_hal_device_info_t *out_list, size_t start_idx, size_t max_items);
bool   om_asio_is_device_id(const char *device_id);
bool   om_asio_is_handle(const om_hal_handle_t *h);

int    om_asio_open(const char *device_id, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap);
int    om_asio_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames);
void   om_asio_drain(om_hal_handle_t *h);
void   om_asio_drop(om_hal_handle_t *h);
void   om_asio_close(om_hal_handle_t *h);

#endif /* OURMUSIC_HAL_ASIO_H */
