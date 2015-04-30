/*
 * @brief
 *
 * @note
 * Author: Mikeqin Fengling.Qin@gmail.com
 * 		   Xiangfu@canaan-creative.com
 *
 * @par
 * This is free and unencumbered software released into the public domain.
 * For details see the UNLICENSE file at the root of the source tree.
 */

#include <string.h>

#include "board.h"
#include "defines.h"
#include "avalon_a3222.h"
#include "protocol.h"
#include "sha2.h"

#define LPC_SSP           LPC_SSP0
#define SSP_DATA_BITS     SSP_BITS_8
#define SSP_MODE_MASTER   1

#define A3222_WORK_SIZE		(23 * 4)
#define A3222_WORK_CNT		8

#define A3222_REPORT_SIZE	12 /* work_id (8 bytes) + nonce (4bytes) */
#define A3222_REPORT_CNT	12

static uint8_t g_freqflag;
static uint32_t g_freq[ASIC_COUNT][3];
static uint8_t g_a3222_works[A3222_WORK_SIZE * A3222_WORK_CNT];
static uint8_t g_a3222_reports[A3222_REPORT_SIZE * A3222_REPORT_CNT];
static uint8_t g_spi_txbuf[A3222_WORK_SIZE];
static uint8_t g_spi_rxbuf[A3222_WORK_SIZE];
RINGBUFF_T a3222_rxrb;
RINGBUFF_T a3222_txrb;
static uint8_t g_asic_index = 0;

static inline uint16_t bswap_16(uint16_t value)
{
        return ((((value) & 0xff) << 8) | ((value) >> 8));
}

static inline uint32_t bswap_32(uint32_t value)
{
	return (((uint32_t)bswap_16((uint16_t)((value) & 0xffff)) << 16) | \
        (uint32_t)bswap_16((uint16_t)((value) >> 16)));
}

static void init_pinmux(void)
{
	Chip_IOCON_PinMuxSet(LPC_IOCON, 0, 2, (IOCON_FUNC0));	/* LOAD */
	Chip_GPIO_SetPinDIROutput(LPC_GPIO, 0, 2);

	Chip_IOCON_PinMuxSet(LPC_IOCON, 1, 29, (IOCON_FUNC1 | IOCON_MODE_PULLUP));	/* SCK0 */
	Chip_IOCON_PinMuxSet(LPC_IOCON, 0, 8, (IOCON_FUNC1 | IOCON_MODE_PULLUP));	/* MISO0 */
	Chip_IOCON_PinMuxSet(LPC_IOCON, 0, 9, (IOCON_FUNC1 | IOCON_MODE_PULLUP));	/* MOSI0 */
}

static void load_set(bool On)
{
	Chip_GPIO_SetPinState(LPC_GPIO, 0, 2, On);
}

static void spi_init(void)
{
	SSP_ConfigFormat ssp_format;

	Chip_SSP_Init(LPC_SSP);
	ssp_format.frameFormat = SSP_FRAMEFORMAT_SPI;
	ssp_format.bits = SSP_DATA_BITS;
	ssp_format.clockMode = SSP_CLOCK_MODE0;

	Chip_SSP_SetFormat(LPC_SSP, ssp_format.bits, ssp_format.frameFormat, ssp_format.clockMode);
	Chip_SSP_SetMaster(LPC_SSP, SSP_MODE_MASTER);
	Chip_SSP_Enable(LPC_SSP);
}

void a3222_init(void)
{
	uint8_t i;

	init_pinmux();
	load_set(0);

	spi_init();

	g_freqflag = 0xf;
	for (i = 0; i < ASIC_COUNT; i++) {
		g_freq[i][0] = A3222_DEFAULT_FREQ;
		g_freq[i][1] = A3222_DEFAULT_FREQ;
		g_freq[i][2] = A3222_DEFAULT_FREQ;
	}

	RingBuffer_Init(&a3222_rxrb, g_a3222_reports, A3222_REPORT_SIZE, A3222_REPORT_CNT);
	RingBuffer_Init(&a3222_txrb, g_a3222_works, A3222_WORK_SIZE, A3222_WORK_CNT);
}

void a3222_roll_work(uint8_t *pkg, int ntime_offset)
{
	uint32_t timev = 0;

	PACK32(pkg + 56, &timev);
	timev += ntime_offset;
	UNPACK32(timev, pkg + 56);
}

int a3222_push_work(uint8_t *pkg)
{
	uint32_t pre_a[3], pre_e[3];

	sha256_loc(pkg, pkg + 52, pre_a, pre_e);

	memset(g_spi_txbuf, 0, A3222_WORK_SIZE);
	memset(g_spi_rxbuf, 0, A3222_WORK_SIZE);

	pre_a[2] = bswap_32(pre_a[2]);
	UNPACK32(pre_a[2], g_spi_txbuf + 4);    /* a2 */

	memcpy(g_spi_txbuf + 8, pkg, 32);		/* midstate */

	pre_e[0] = bswap_32(pre_e[0]);
	pre_e[1] = bswap_32(pre_e[1]);
	pre_e[2] = bswap_32(pre_e[2]);
	pre_a[0] = bswap_32(pre_a[0]);
	pre_a[1] = bswap_32(pre_a[1]);
	UNPACK32(pre_e[0], g_spi_txbuf + 40);	/* e0 */
	UNPACK32(pre_e[1], g_spi_txbuf + 44);	/* e1 */
	UNPACK32(pre_e[2], g_spi_txbuf + 48);	/* e2 */
	UNPACK32(pre_a[0], g_spi_txbuf + 52);	/* a0 */
	UNPACK32(pre_a[1], g_spi_txbuf + 56);	/* a1 */

	memcpy(g_spi_txbuf + 60, pkg + 52, 12); /* data */

	memcpy(g_spi_txbuf + 72, pkg + 32, 8);	 /* work id */

	if ((g_freqflag >> g_asic_index) & 1) {
		g_freqflag &= ~(1 << g_asic_index);
		UNPACK32(g_freq[g_asic_index][0], g_spi_txbuf + 80);
		UNPACK32(g_freq[g_asic_index][1], g_spi_txbuf + 84);
		UNPACK32(g_freq[g_asic_index][2], g_spi_txbuf + 88);
	} else {
		memcpy(g_spi_txbuf + 80, "\x0\x0\x0\x1", 4);
		memcpy(g_spi_txbuf + 84, "\x0\x0\x0\x1", 4);
		memcpy(g_spi_txbuf + 88, "\x0\x0\x0\x1", 4);	/* PLL, Voltage: 0.7625 */
	}

	g_asic_index++;
	g_asic_index %= ASIC_COUNT;

	return RingBuffer_Insert(&a3222_txrb, g_spi_txbuf);
}

static int a3222_process_work(uint8_t *spi_txbuf)
{
	int i;
	uint32_t tmp, ret;
	uint32_t last_nonce = 0xbeafbeaf;

	Chip_SSP_DATA_SETUP_T  xf_setup;

	uint8_t report[A3222_REPORT_SIZE];

	xf_setup.length = A3222_WORK_SIZE;
	xf_setup.tx_data = spi_txbuf;
	xf_setup.rx_data = g_spi_rxbuf;
	xf_setup.rx_cnt = 0;
	xf_setup.tx_cnt = 0;
	ret = Chip_SSP_RWFrames_Blocking(LPC_SSP, &xf_setup);
	if (ret == ERROR) {
		DEBUGOUT("%s-%d: Chip_SSP_RWFrames_Blocking %d failed!\n", __FUNCTION__, __LINE__, ret);
		return 1;
	}

	/* 8 bytes work_id */
	memcpy(report, g_spi_rxbuf, 8);
	for (i = 0; i < 8; i++) {
		memcpy(report + 8, g_spi_rxbuf + 8 + i * 4, 4);
		tmp = report[8] << 24 | report[9] << 16 | report[10] << 8 | report[11];
		if (tmp == 0xbeafbeaf || tmp == last_nonce)
			continue;

		last_nonce = tmp;
		RingBuffer_Insert(&a3222_rxrb, report);
	}

	return 0;
}

void a3222_process(void)
{
	int i;
	uint8_t load[2];

	if (RingBuffer_GetCount(&a3222_txrb) < ASIC_COUNT)
		return;

	for (i = 0; i < ASIC_COUNT; i++) {
		RingBuffer_Pop(&a3222_txrb, g_spi_txbuf);
		a3222_process_work(g_spi_txbuf);
	}

	load_set(1);
	Chip_SSP_WriteFrames_Blocking(LPC_SSP, load, 2);	/* A3222 load needs 8 cycle clocks */
	load_set(0);
}

int a3222_get_report_count(void)
{
	return RingBuffer_GetCount(&a3222_rxrb);
}

int a3222_get_report(uint8_t *report)
{
	return RingBuffer_Pop(&a3222_rxrb, report);
}

/* index must <= ASIC_COUNT */
void a3222_set_freq(uint32_t *freq, uint8_t index)
{
	if (!memcmp(freq, &g_freq[index], sizeof(uint32_t) * 3))
		return;

	g_freqflag |= (1 << index);
	memcpy(g_freq[index], freq, sizeof(uint32_t) * 3);
}

/* index must <= ASIC_COUNT */
void a3222_get_freq(uint32_t freq[], uint8_t index)
{
	memcpy(freq, &g_freq[index], sizeof(uint32_t) * 3);
}
